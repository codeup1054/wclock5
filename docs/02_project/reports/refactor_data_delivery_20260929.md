# Отчёт · Рефакторинг доставки данных · 2026-09-29
- эпик: `docs/02_project/epics/EPIC_data_delivery_refactor.md`
- беклог: `docs/02_project/backlogs/backlog_20260929.ldn.md`
- статус: ✅ Цели №1–№3 закрыты и задеплоены на прод (217.114.8.5:10405)

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
| Метрика | baseline | after | Δ |
|---|---|---|---|
| строк app.py | 1170 | 1133 | **−37** |
| дубль-маркеров (`_stable_token`/`_section_token`) | 2 | 0 | **−2** |
| общий движок (`app_uses_shared_engine`) | false | true | ✅ |
| суммарно строк доставки | 8860 | 8853 | −7 |
| файлов доставки | 14 | 14 | = (стабильно) |
| бенч опроса медиатора (median, 3 прогона) | 21.38 мс | 23.48 мс | +2.1 мс (шум, < ×2 лимита) |

Ограничение прироста строк: подкласс+инстанс в app.py добавили ~35 строк, но вычистили
двойную логику токенов (net −90 → −37). Дальнейшее сжатие — P4 (blueprints), P3 (1 SELECT),
P5 (InvestData на клиенте).

## Тесты (unittest, локально, PYTHONUTF8=1)
- `tests/test_mediator_engine.py` — 16 кейсов движка (stable_token, дельта, неизвестная
  секция, params→reader, хуки WClock, write-интервал/ошибки, форма process).
- `tests/test_mediator_contract.py` — 7 кейсов контракта routes (полный опрос → токены
  всех 8 секций, второй опрос без статичных секций, явный after_ts → `_tail`, unknown
  section, battery applied/validation/skipped). Толерантен к `[ERROR] no such column:
  tgld_value` на старой локальной БД (прод-БД мигрирована).
- `tests/test_metrics.py` — 7 ассертов улучшений vs `metrics_baseline.json`.
- Итог: **Ran 34 tests OK** + **7 метрик OK**; `py_compile` app.py/panel_mediator.py,
  `node --check` invest_banner.js — чисто.

## Деплой и проверка прода
1. `app.py` scp→cp→`docker compose restart`; `panel_mediator.py`, `invest_repo.py`,
   `docker-compose.yml`, `static/js/invest_banner.js` — MD5 совпадают.
2. **Авария в процессе деплоя**: контейнер падал `ModuleNotFoundError: No module named
   'panel_mediator'` — модуль есть только в образе, а образ собран до его появления
   (в `docker-compose.yml` у `wclock` были смонтированы только `app.py`/static/parsers).
   → в compose добавлены mounts `./panel_mediator.py` и (аналогичная причина)
   `./invest_repo.py:/app/invest_repo.py`; контейнер пересоздан через `docker compose up -d wclock`.
3. **Найдена корневая причина** неработавшего хвоста: в образе прод-`invest_repo.py`
   `_latest_epoch` добавлялся ТОЛЬКО в tail-режиме (`if tail and latest_epoch`), поэтому
   полная загрузка не несла эпохи → клиент не делал `after_ts` → 5с-поллы были полными.
   Локальная версия уже исправлена (`if latest_epoch:` безусловно); после mount+recreate
   на проде:
   - полный опрос: `invest.history` → `_latest_epoch=1790665431`, `_count=720`;
   - второй опрос с теми же токенами → `changed: ['invest.history']` (дельта);
   - `params.after_ts=epoch` → `_tail: true`, `count: 1`;
   - battery write → `applied: true`; unknown section → `_error`;
   - `GET /api/weather` → 200.

## Уроки на будущее (деплой)
- Новые python-файлы приложного слоя должны либо входить в образ (rebuild), либо
  монтироваться в compose + деплоиться scp вместе с app.py. В отчёт добавлен список
  mounts. Проверка после рестарта: `docker ps` статус `Up`, а не `Restarting`.

## Артефакты
- `tests/metrics_baseline.json`, `tests/metrics_after.json` — пара до/после.
- `docs/02_project/epics/EPIC_data_delivery_refactor.md` — план P1–P8.
- Дальше: P2 «Тариф процентный» → демон; P3 бакет-таблица; P4 blueprints; P5 InvestData;
  P7 epoch-время; P8 кэш-политика (см. беклог).

## Промпт-рецепт
> Рефакторинг доставки данных P1+P6: тесты `PYTHONUTF8=1 ./venv/Scripts/python.exe -m unittest discover -s tests -p 'test_*.py' -v`, метрики `python tests/metrics.py tests/metrics_after.json`, деплой = scp app.py, panel_mediator.py, invest_repo.py, docker-compose.yml, static/js/invest_banner.js (MD5) + `docker compose up -d wclock`, повтори батч-2 P2–P8.