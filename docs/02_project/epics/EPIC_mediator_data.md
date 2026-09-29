---
title: Эпик — Медиатор данных клиент↔сервер (единый /api/data_mediator)
fnd: GEN
typ: EPIC
ver: 0.1
updated: 2026-09-17
status: 🚧
---
# Эпик — Медиатор данных (data mediator)

Единая точка обмена клиент↔сервер вместо N отдельных периодических запросов:
`POST /api/data_mediator` с токенизированной дельтой по секциям. Клиент шлёт
известные токены секций, сервер возвращает только изменившиеся секции +
новые токены. Write-гранулярность настраивается per-секция.

## Контекст

Каждый 10-секундный тик дашборда выполняет 4+ независимых запроса:

| Запрос | Размер | Частота | Источник |
|--------|--------|---------|----------|
| `/api/weather` | ~1–3 kB | 10 мин | Яндекс Погода |
| `/api/charts_data` | ~0.7 kB | 10 мин | БД погоды |
| `/api/battery` (GET) | ~0.8 kB | 15 мин | график батареи |
| `/api/invest/turnover` | ~0.3 kB | 10 с | оборот дня |
| `/api/invest/history` (full) | до 952 kB | 30–60 с | история капитала |
| `/api/invest/tickers` | 208 kB→34 kB | 30 с (TTL) | тикеры |
| `/api/invest/history` (delta) | 0.4 kB | 10 с | после фикса кэша |
| `/api/battery` (POST write) | ~0.1 kB | 10–60 с | телеметрия |
| `/api/settings` | ~IL | редкие | настройки |

Итог до оптимизаций: ~1.2 МБ/тик. После дельты+gzip+TTL: ~1.1 kB/тик
(×1000). Но остаётся N запросов с независимой свежестью и дублированием
данных между виджетами (баннер и чарт держат одну историю в двух
клиентских кэшах).

Цель медиатора — один транспорт, одна точка согласования свежести,
дельта по секциям с токенами, write-гранулярность из настроек.

## Решение

### 1. Чтение: единый POST `/api/data_mediator`

```
POST /api/data_mediator
{ "v": { "<секция>": "<токен клиента>", ... } }

200
{
  "changed": { "<секция>": <данные>, ... },   // только изменившиеся
  "tokens": { "<секция>": "<новый токен>", ... },
  "ts": <unix_epoch_sec>
}
```

- Клиент хранит токен каждой секции (стиль `interval|period|start|end`).
- Сервер считает свежие данные, вычисляет их токен (hash payload) и
  сравнивает с присланным; расхождение → секция в `changed` + новый токен.
- Совпадение → секция не в `changed`, но токен всё равно обновляется
  (клиент всегда получает актуальные токены всех секций).
- Падение одной секции не роняет ответ: секция с ошибкой → поле
  `errors: {<секция>: <message>}`.

### 2. Секции чтения

| Ключ секции | Токен | Данные | TTL сервера |
|-------------|-------|--------|-------------|
| `weather` | hash payload | `{fact, forecast_summary}` | 300 с |
| `charts_data` | hash payload | агрегированный timeline | 600 с |
| `battery.history` | hash payload | история для графика батареи | 60 с |
| `invest.history` | `hash(history)` или `_latest_epoch` | история капитала (delta-capable) | 30 с |
| `invest.tickers` | hash payload | тикеры | 30 с (клиентский TTL) |
| `invest.turnover` | hash payload | оборот дня | 90 с (in-memory) |
| `invest.turnover_details` | hash payload | детализация оборота | 90 с |
| `settings` | hash payload | настройки | по изменению |
| `user_settings` | hash payload | настройки пользователя | по изменению |

> **Солнце не входит**: восход/закат/долгота дня — клиентская формула
> `getDaylight()` (солнечная геометрия, без серверной секции).

### 3. Запись: write-секции в том же POST

```
POST /api/data_mediator
{ "w": { "<секция>": <payload> } }
```

Ответ:

```
{
  "writes": {
    "<секция>": { "applied": true|false, "reason": "ok|interval|unchanged|missing_key" }
  },
  ...
}
```

- **Гранулярность настраивается**: `write_interval_battery` (default 60 с),
  `write_interval_weather`… Секция пишется, только если прошло ≥ интервала
  **и** значение изменилось. Иначе `applied: false` + `reason`.
- Если писать не нужно — сервер не делает INSERT, отвечает
  `{applied: false, reason: ...}`, токены секций всё равно обновляются
  (клиент не «застревает»).

### 4. Батарея (детально)

Сегодня POST `/api/battery` каждые 10 с: `INSERT OR REPLACE` + commit —
худший случай записи. В медиаторе:

- Write-секция `battery` c `write_interval_battery` (default 60 с).
- Клиент шлёт `{w: {battery: {device_id_local, value}}}` в общем POST.
- Сервер: если не прошёл интервал или значение не изменилось → skip,
  иначе INSERT. Отклик `{applied, reason}`.
- Чтение для графика — секция `battery.history` (`device_id_local`,
  `interval`, `period`).

### 5. Клиент: PanelMediator

Новый модуль `static/js/panel_mediator.js`:

- Единый цикл опроса `/api/data_mediator` (интервал 10 с — как сейчас cron).
- Словарь токенов по секциям, дельта-контракт с сервером.
- Диспетчеризация: секция изменилась → вызываются подписчики этого виджета
  (weather → `updateWeatherData`, battery.history → `updateBatteryChart`,
  invest.history → `InvestHistoryCache`/`InvestBanner`, tickers →
  `loadTickersToChart`, turnover → `updateInvestBanner`).
- Write-планировщик батареи по интервалу настроек.
- Fallback: при недоступности `/api/data_mediator` — старые прямые запросы
  (обратная совместимость, поэтапная миграция).

## Задачи

| Код | Задача | Результат | Статус |
|-----|--------|-----------|--------|
| MN-01 | Сервер: `POST /api/data_mediator` (read-скелет) | парсинг `v`, токены, `changed/tokens/ts/errors` | ✅ |
| MN-02 | Секции: weather, charts_data | переиспользование `get_weather`, charts query | ✅ |
| MN-03 | Секции invest: history (delta), tickers, turnover | обёртки над `invest_repo` + кэши | ✅ |
| MN-04 | Секция battery.history + write-секция battery | read для графика, write с `write_interval_battery` | ✅ |
| MN-05 | Секции settings / user_settings | чтение настроек | ✅ |
| MN-06 | Клиент: `panel_mediator.js` | токены, цикл, диспетчеризация, write-батарея | ✅ |
| MN-07 | Миграция weather/battery на медиатор | `index.js`, `battery.js` | ✅ |
| MN-08 | Миграция invest_banner/invest_chart на медиатор | баннер, чарт, легенда, tickers | ✅ |
| MN-09 | Fallback + регресс старых эндпоинтов | старые `/api/*` не ломаются | ✅ |
| MN-10 | Эпик: MD + HTML | `EPIC_mediator_data.md`/`.html` | ✅ |

## Проверка

- `py_compile app.py` после правок сервера.
- `node --check static/js/panel_mediator.js` + правки виджетов.
- Smoke: `curl -X POST /api/data_mediator -d '{"v":{}}'` → все секции в `changed`;
  повтор с полученными токенами → `changed` пуст.
- Write: POST батареи дважды в пределах интервала → второй `applied:false`.
- MD5 после деплоя; рестарт `wclock5-app`.

## Связи

- Беклог: `docs/02_project/backlogs/backlog_20260917.ldn.md` (MN-01..17)
- Конвенции: `docs/02_project/conventions.md` §10 «Медиатор данных» +
  `conventions.html`
- Код: `app.py`, `invest_repo.py`, `static/js/panel_mediator.js`,
  `static/js/invest_banner.js`, `invest_chart.js`, `battery.js`,
  `static/js/index.js`

## Лист изменений

- **0.1** · 2026-09-17 — создан: контракт чтения/записи `/api/data_mediator`, секции,
  write-гранулярность батареи, PanelMediator, задачи MN-01..10.
