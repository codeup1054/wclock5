# WClock · десктоп-синхронизация с планшетом

Забирает накопленную историю портфелей, статистику и алерты с планшета-киоска
по LAN, складывает в parquet-архив и горячую БД, показывает окно, пишет
журнал и при переполнении чистит историю на планшете (с подтверждением).

## Быстрый старт

```powershell
cd E:\_dev\10.gpx\04.gpx_clock_beget\wclock5
.\venv\Scripts\python.exe -m pip install -r parsers\invest\desktop_sync\requirements-sync.txt
parsers\invest\desktop_sync\run.bat           # окно
parsers\invest\desktop_sync\run.bat --once    # один проход в консоли
```

Или из корня проекта:

```powershell
.\venv\Scripts\python.exe -m parsers.invest.desktop_sync --once
```

## Планшет: порт и API

- **8080** — loopback для WebView (`http://127.0.0.1:8080/`), в LAN не отдаётся.
- **9090** — LAN-порт синхронизации (`Cfg.lanPort`, по умолчанию 9090).
  В этой сети порт 8080 с ПК режется (TCP reset), поэтому он вынесен отдельно.
- `bind` — `0.0.0.0` (AF_INET), без авторизации: только доверенная сеть.

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/api/ping` | `{"ok":true,"device":"WClock","version":"0.1-mvp","ts":…}` |
| GET | `/api/stats` | `cpu`, `rssMb`, `histBytes`, `histPoints`, `level`, `battery`, `uptimeSec`, `lanPort` |
| GET | `/api/invest/history?since=<ms>` | `{"rows":{src:[[ts,v],…]},"last":…,"histBytes":…,"histPoints":…}` |
| POST | `/api/invest/prune?before=<ms>` | `{"removed":N,"left":N}` |
| GET | `/api/alerts?since=<ms>` | `{"alerts":[{"ts":…,"level":"warn","text":"…"}]}` |

`since`/`before` — epoch **мс**.

## Что куда пишется

| Хранилище | Путь | Назначение |
|---|---|---|
| Parquet | `data/invest_YYYYMM.parquet` | полный архив, ротация по 500 МБ (`_p2`, …) |
| SQLite fallback | `data/invest.db` | если нет pandas/pyarrow; `UNIQUE(source, ts)` |
| Горячая БД | `../invest_portfolio.db` | `invest_buckets` (`res='min'`) — графики; `portfolio_history` — только свежие 10 мин |
| Журнал синка | `logs/sync_log.csv` | точки, диапазон, байты, prune, ошибки |
| Алерты | `logs/alerts.db` + `logs/alerts.csv` | SQLite для анализа, CSV для просмотра |
| Состояние | `logs/sync_state.json` | последняя полная сверка, last alerts ts |

Дедупликация: `(source, ts)`. Раз в `fullSyncHours` (24 ч) делается полная
сверка `since=0` — она ловит расхождения в старых точках и новые счета.

## Алгоритм прохода

1. `ping` → `stats`; проверки часов, CPU/RSS, объёма истории.
2. `history(since)`; `since = min(последних ts по счетам)`.
3. Архив: parquet/SQLite, конфликты фиксируются.
4. Горячая БД: `invest_buckets` + свежий `portfolio_history`.
5. Проверка: архив покрывает последнюю точку планшета.
6. Если история планшета > `maxTabletKb` — предложить prune (диалог).
7. Алерты планшета (`/api/alerts`) → общий журнал с префиксом `[TAB]`.
8. Telegram (warn/alert) с префиксом `[SK_DESK]`; при сбое — очередь.

## Приватность расхождений

- Допуск: 0.3 % (точки снимаются в разные секунды) — это шум, не алерт.
- Для точек ровно на `:00` допускается совпадение с любой минутой часа:
  seed планшета использует метку «начало часа», а значение — close одной
  из минут (сборка из незавершённого часа).
- Последняя точка обновляется планшетом при каждом опросе — её изменение
  не считается расхождением.
- Реальные расхождения (пропавшая позиция, пустой счёт) дают проценты,
  а не доли процента.

## Prune

- Порог: `histBytes > maxTabletKb` (200 КБ).
- Удаляются точки старше `keepDaysOnTablet` (7 суток) **после** успешной
  записи в архив и проверки `archive.max_ts >= tablet.last`.
- `askBeforePrune=true` — окно с подтверждением; в CLI используйте `--yes`.
- `pruneAfterSync=false` — только алерт `tablet.buffer`, без удаления.

## Алерты

| Код | Когда |
|---|---|
| `sync.unreachable` | планшет не отвечает после ретраев |
| `sync.failed` | ошибка ответа/записи |
| `sync.divergence` | значения в одной точке расходятся |
| `sync.gap` | нет новых точек дольше `2 × syncMinutes` |
| `tablet.buffer` | история > 200 / 400 КБ |
| `tablet.resources` | CPU > 60/80 %, RSS > 180/240 МБ |
| `tablet.clock` | часы расходятся > 60 с |
| `tablet.alert` | алерт с планшета (префикс `[TAB]`) |
| `archive.rotate` / `archive.vacuum` | размер архива |
| `prune.proposed` / `prune.done` / `prune.skipped` | очистка |

Telegram: `telegramToken` + `telegramChatId` (можно через `.env`:
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_PROXY`). Без токена
алерты копятся в БД (`sent=0`), окно показывает «не отправлено».

## Настройки (`config.json`)

Создаётся кнопкой «Настройки»; `config.example.json` — образец.

| Ключ | По умолчанию | Смысл |
|---|---|---|
| `host` / `port` | `192.168.3.33` / `9090` | планшет |
| `syncMinutes` | 10 | период автосверки |
| `fullSyncHours` | 24 | период полной сверки (`0` — каждый раз) |
| `maxTabletKb` | 200 | порог prune |
| `keepDaysOnTablet` | 7 | что оставлять на планшете |
| `maxArchiveMb` | 500 | ротация parquet |
| `askBeforePrune` | true | подтверждение удаления |
| `telegram*` | — | токен, чат, прокси |

## Проверка без планшета

```powershell
.\venv\Scripts\python.exe -m parsers.invest.desktop_sync.selftest
# или вручную:
.\venv\Scripts\python.exe -m parsers.invest.desktop_sync --mock normal --once
```

`mock_tablet.py` поднимает локальный сервер с 14 сутками истории; сценарии
`normal`, `divergence`, `bigbuffer`.

## Ограничения

- Только LAN; облако/VPS не используется.
- Нет авторизации API — не выставляйте порт 9090 в интернет.
- Telegram из этой сети может быть недоступен (нужен `telegramProxy`).
- При первом запуске архив пуст → тянется вся история (может быть 10–20 тыс. точек).
