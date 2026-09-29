# Отчёт · Рефакторинг доставки данных · 2026-09-29
- эпик: `docs/02_project/epics/EPIC_data_delivery_refactor.md`
- беклог: `docs/02_project/backlogs/backlog_20260929.ldn.md`
- статус: ✅ батчи 1–3 (P1+P6, P2, P3) + внебатчевые фиксы закрыты и задеплоены на прод (217.114.8.5:10405)

## Что сделано (батч-1: P1 + P6)

### P1 — единый движок медиатора
- `panel_mediator.py` (+26 строк): хуки `prepare_params` / `post_read` / `section_token`
  с контекстом `ctx` (не в self — медиатор общий для потоков), `process(body)`
  читает `params|p`, возвращает `writes`, write-ошибка ловится по `ok is False` **и**
  по `_error` (кейс `_write_battery_payload` без `ok`).
- `app.py` (−37 строк): подкласс `_WClockMediator(PanelMediator)` со всей tail-логикой
  invest.history (после_ts из params, BC-декодирование цифрового токена, `_tail`,
  токен `_latest_epoch`); маршрут `api_data_mediator` — один вызов `_DATA_MEDIATOR.process(body)`;
  `_stable_token`/`_section_token` удалены, пустой `v` сохраняет `params`/`write` из body.

### P6 — явный after_ts
- `static/js/invest_banner.js` (+4 строки): `mediatorHistoryParams()` шлёт
  `params.after_ts = lastDataEpoch` (первый опрос — полная загрузка без after_ts).
- Сервер предпочитает `params.after_ts`, цифровой токен — fallback (протокол не сломан).

## Метрики (tests/metrics.py)
| Метрика | baseline | after (батч-3) | Δ |
|---|---|---|---|
| строк app.py | 1170 | 1126 | **−44** |
| дубль-маркеров (`_stable_token`/`_section_token`) | 2 | 0 | **−2** |
| общий движок (`app_uses_shared_engine`) | false | true | ✅ |
| суммарно строк доставки | 8860 | 9067 | +207 (легитимно: P2 тарифы + P3 бакеты) |
| файлов доставки | 14 | 14 | = (стабильно) |
| бенч опроса медиатора (median, 3 прогона) | 21.38 мс | 22.79 мс | +1.4 мс (шум, < ×2 лимита) |

Ограничение прироста строк: подкласс+инстанс в app.py добавили ~35 строк, но вычистили
двойную логику токенов (net −90 → −37). Дальнейшее сжатие — P4 (blueprints), P5 (InvestData на клиенте).
`tests/test_metrics.py` допускает рост общего total_lines в пределах +10% (целевые проверки
app.py/дубли/bench — отдельные тесты).

## Батчи 2–3 и внебатчевые фиксы

### Батч-2 (P2) + прод-баг баннера
- **Прод-баг**: секция `invest.history` падала в `_error` при `end_ts='live'` (live-режим чарта
  хранит `invest_panel_end_ts='live'` в localStorage, баннер шлёт его в params медиатора →
  `int('live')` → `ValueError` → `onMediatorHistory` early-return → пустая таблица). Фикс:
  `_int_or_none` для `start_ts/end_ts` в `_invest_history_payload` (как в GET-пути и у tickers);
  `docker compose restart wclock` (up -d не перезагружал модуль в памяти bind-mount). Регресс-тест
  `test_end_ts_live_not_error`. Проверка: POST с `end_ts='live'` → `error: None` + полный payload.
- **P2**: «Тариф процентный» → демон (`tariff_details`, save_tariff уpsert по raw_md5,
  backfill при старте, хук в scan_channel), app.py читает JSON (import re удалён, app.py 1170→1126);
  `tests/test_tariff.py` (8), контракт-тест схемы details. Прод: «💾 тариф: добавлено из bot_events: 30».

### Батч-3 (P3) — единая бакет-таблица
- `invest_buckets (ts_epoch, source, res='min'|'hour', UNIQUE(ts_epoch,source,res))` —
  единственная точка записи `apply_retention_impl` (минуты→часы по 30д, самоздание таблицы
  на старой БД), миграция идемпотентно копирует legacy portfolio_min/hourly.
- `read_history` → 1 SELECT по бакетам + RAW-оверлей свежего окна `max(cutoff, now−90с)`
  + fallback на legacy/полный raw при пустых бакетах; `_prev` из бакетов; большой скан
  сырых секунд уходит из горячего пути.
- Тесты `tests/test_invest_buckets.py` (5: фолд минуты, чтение бакетов, RAW-оверлей свежей
  секунды, миграция идемпотентна, fallback без бакетов). Итог: **49 OK (1 skip)**.
- Деплой: `invest_repo.py` scp→cp→MD5, `docker compose restart wclock`, `systemctl restart tg-turnover`.
  **Важно**: демоны invest-parser/finam-invest-parser не видели новый `invest_repo.py` (только образ) —
  в compose добавлен mount `./invest_repo.py:/app/invest_repo.py` и контейнеры пересозданы
  `docker compose up -d --force-recreate invest-parser finam-invest-parser`. Миграция на проде:
  «⚠ новые бакеты: 48086» (свечей 2014).
- Прод-проверка: GET history 840 точек + `_latest_epoch`/`_prev`; медиатор `invest.history`
  724 ключа с позициями в последнем ключе; полный опрос медиатора HTTP 200 (все 8 секций в tokens).

### Вне батчей — формат капитала
- Баннер (`invest_banner.js:871`) и подписи значений на графике (`invest_chart.js:841`)
  показывали «тыс. ₽» (`13 517.45`). Переведены на полные рубли
  `Math.round(v).toLocaleString('ru-RU').replace(/\u00a0/g,' ')` → `13 517 446`.
  `node --check` + `bash sh/deploy_js.sh` (MD5 совпали).

## Уроки на будущее (деплой)
- Новые python-файлы приложного слоя должны либо входить в образ (rebuild), либо
  монтироваться в compose + деплоиться scp вместе с app.py. В отчёт добавлен список
  mounts. Проверка после рестарта: `docker ps` статус `Up`, а не `Restarting`.
- Bind-mount python в контейнере не подхватывается без перезапуска контейнера:
  `docker compose up -d` может НЕ рестартовать (считает конфиг неизменным) —
  используй `--force-recreate` при изменениях volumes.

## Артефакты
- `tests/metrics_baseline.json`, `tests/metrics_after.json` — пара до/после.
- Коммиты: `48534fb` (hotfix баннера), `a381f06` (P2), `2a87f0e` (P3).
- Дальше: P4 blueprints app.py (цель app.py <1090); P5 InvestData; P7 epoch-время; P8 кэш-политика
  (см. беклог).

## Промпт-рецепт
> Рефакторинг доставки данных P1–P3: тесты `PYTHONUTF8=1 ./venv/Scripts/python.exe -m unittest discover -s tests -p 'test_*.py' -v`, метрики `python tests/metrics.py tests/metrics_after.json`, деплой = scp app.py/panel_mediator.py/invest_repo.py/docker-compose.yml/static/js/* (MD5) + `docker compose restart wclock` + `docker compose up -d --force-recreate invest-parser finam-invest-parser` + `systemctl restart tg-turnover`.