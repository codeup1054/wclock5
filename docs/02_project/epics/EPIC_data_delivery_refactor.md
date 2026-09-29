---
title: Эпик — Рефакторинг доставки данных (демоны → БД → кэш → медиатор → фронт)
fnd: DRI
typ: EPIC
ver: 0.2
updated: 2026-09-29
status: 🚧
---
# Эпик — Рефакторинг доставки данных

Цель: привести конвейер данных к симметричному виду
`демон → нормализация → бакет → медиатор → DTO → рендер`, убрать дубли
(движок медиатора, парсинг, тикер-кэши, фолд-таблицы), сократить код и
число запросов, измеримо подтвердить результат (строки, файлы, скорость).

## Карта «как есть» (29.09, до рефакторинга)

```
Mail.ru ─┐                  ┌─ portfolio_positions (raw 1–60с)
Tinkoff ─┤                 ┌─ portfolio_history
Finam ───┼─ демоны ── норм. ─┼─ portfolio_hourly / portfolio_min (фолд)
Tinkoff+_┼─ (DTO)          ├─ trades, turnover_daily, strategy_summary
yfinance ├─                ├─ bot_events, last_prices
Telegram ┘                 └─ odintsovo_weather.db
                        ↓
        кэш: дисковый lazy (cache/*, mtime|TTL) + in-memory _turnover_cache + бакет-таблицы
                        ↓
        POST /api/data_mediator — дельта по стабильным токенам (SHA-256; invest.history = _latest_epoch)
                        ↓
        клиент: panel_mediator.js poll 5с → invest_chart_helpers (InvestHistoryCache) → banner/chart/weather
```

## Диагноз (слабые места)

1. **Два движка медиатора**: app.py содержит свою копию цикла read/write +
   `_stable_token`/`_section_token`, а `panel_mediator.py` (чистый движок) —
   не используется вообще. (P1)
2. **Токен как данные**: `invest.history` токен = `_latest_epoch` (число),
   сервер «додумывает» `after_ts = int(client_tok)`. (P6)
3. **Парсинг в API-слое**: «Тариф процентный» разбирается regex-ом в рантайме
   `_invest_turnover_details_payload` (app.py:967–1026), дублируя парсер демона. (P2)
4. **Три слоя кэша без политики**: диск + in-memory + бакет-таблицы. (P8)
5. **Три фолд-таблицы** raw/hourly/min + merge в `read_history` (монстр 371–655). (P3)
6. **Дубли на клиенте**: тикер-кэши chart (`__investTickerCache`) и banner;
   парсинг payload двумя независимыми путями. (P5)
7. **God-file** `app.py` (1170 строк): routes + SQL + кэш + медиатор + парсинг. (P4)

## План работ (приоритизировано, от безопасного к структурному)

| # | Работа | Эффект | Статус |
|---|---|---|---|
| P1 | Единый движок медиатора: app.py → `PanelMediator` (хуки prepare/post/section_token), удалить копию токен-функций | −80–100 строк app.py, один источник правды | ✅ батч-1 |
| P6 | Явный `after_ts` в `params.invest.history` (клиент шлёт), сервер не декодирует токен | протокол чистый, тестируемый | ✅ батч-1 |
| P2 | Парсинг «Тариф процентный» → в демон (`tariff_details`), API читает таблицу | −150–200 строк, regex из 5с-цикла | ✅ батч-2 |
| P3 | Единая бакет-таблица `invest_buckets`, `read_history` → 1 SELECT | −400–500 строк, стабильный кэш | ✅ батч-3 |
| P4 | `app.py` → blueprints (portal/invest/mediator) + SQL→repo | структура, тестируемость | ⏳ далее |
| P5 | Единый DataLayer `InvestData` (invest_chart_helpers.js): подписки+fallback+DTO | один тикер-кэш, −200–300 строк клиента | ⏳ далее |
| P7 | Один формат времени (epoch) в payload/медиаторе | меньше конвертаций | ⏳ далее |
| P8 | Кэш-политика: in-memory LRU для секций медиатора + бакеты; диск — тяжёлый GET | предсказуемый TTL | ⏳ далее |

## Метрики успеха (измеримые)

- `app.py`: 1170 → < 1090 строк (baseline в tests/metrics_baseline.json). Выход на цель — после P4 (blueprints); после батча-3: 1126.
- Дубль-маркеры движка (`_stable_token`/`_section_token` в app.py): 2 → 0. ✅
- `app_uses_shared_engine` (`from panel_mediator import`): false → true. ✅
- Медиатор-опрос (POST v={}): не медленнее baseline (21.4 мс, warmed). ✅ (22.79 мс после батча-3, < ×2).
- Контракт: все секции в `tokens`, tail-механика `_latest_epoch` сохраняется. ✅

## Ход работ (батчи)

- **батч-1 (P1+P6)** — единый движок медиатора, явный after_ts. Коммит `cc8c6d3`.
- **батч-2 (P2)** — «Тариф процентный» разбирается демоном один раз в `tariff_details`
  (day/source/payload_json, upsert по raw_md5), app.py читает JSON (import re удалён,
  app.py 1170→1126); контракт-тест схемы details. Коммит `a381f06`.
- **батч-3 (P3)** — единая `invest_buckets (ts_epoch, source, res='min'|'hour', UNIQUE)`;
  писатель `apply_retention_impl` → бакеты (+самоздания таблицы на старой БД), миграция
  `_migrate_portfolio_db` идемпотентно переносит legacy portfolio_min/hourly; `read_history`
  → 1 SELECT по бакетам + RAW-оверлей свежего окна `max(cutoff, now−90с)` + fallback на
  legacy, `_prev` из бакетов; демоны пишут в бакеты. Коммит `2a87f0e`, deploy + force-recreate.
- **Вне батчей** — прод-баг: `invest.history` падал в `_error` при `end_ts='live'` из localStorage
  live-режима чарта (`_int_or_none` в `_invest_history_payload`); кап+график показывали «тыс. ₽» —
  переведены на полные рубли.

## Артефакты

- Тесты: `tests/test_mediator_engine.py`, `tests/test_mediator_contract.py`,
  `tests/test_metrics.py`, `tests/test_tariff.py` (P2), `tests/test_invest_buckets.py` (P3).
  Итог батч-3: **49 OK (1 skip)**.
- Метрики: `tests/metrics_baseline.json` (до), `tests/metrics_after.json` (после).
- Отчёт: `docs/02_project/reports/refactor_data_delivery_20260929.md`.