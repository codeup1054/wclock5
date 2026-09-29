---
title: Эпик — Настройки API сбора данных (серверные, без рестарта)
fnd: GEN
typ: EPIC
ver: 0.1
updated: 2026-09-03
status: 🚧
---
# Эпик — Настройки API сбора данных (Tinkoff / Finam)

Серверные настройки отключения сбора данных через API **отдельно** для
Tinkoff и Finam. Демоны читают настройку каждый цикл и пропускают опрос без
рестарта. UI — переключатели в табе «Настройки» единой модалки Отчётов.

## Контекст

Возникла необходимость остановить сбор с конкретного брокера (например,
перевод активов → Tinkoff весь день 0) без остановки контейнеров и без
влияния на сбор другого источника. Настройка должна применяться демонами
на лету (каждый цикл), а не требовать рестарта.

## Решение

- **Два независимых ключа** в таблице `settings` инвест-БД
  (`invest_portfolio.db`):
  - `invest_collection_tinkoff_enabled` — Tinkoff
  - `invest_collection_finam_enabled` — Finam
  - False = `'0'`, по умолчанию (нет записи) = сбор включён (`'1'`).
- **Фронтенд → БД (не `api/settings`):** настройки пишутся/читаются через
  `/api/user_settings/<device_id>` (БД `user_settings` для остального, но
  эти ключи **маршрутизируются в инвест-БД** `settings`).
- **Демоны** (`tinkoff_invest_daemon.py`, `finam_invest_daemon.py`) читают
  ключ **каждый цикл**; при выкл — печать `⏸️ Сбор данных через … отключён`
  и пропуск тела цикла (fetch/save/retention/trades). Рестарт не нужен.

## Задачи эпика

| Код | Задача | Результат | Статус |
|-----|--------|-----------|--------|
| API-01 | Бэкенд ключей сбора | `_INVEST_COLLECTION_KEYS`; `_get/_write_invest_collection_settings` в `app.py`; маршрутизация через `/api/user_settings` | ✅ |
| API-02 | Seed-дефолты | `invest_collection_*` = 1 в `invest_db.py` | ✅ |
| API-03 | Демон Tinkoff | `collection_enabled()`; пропуск цикла при `'0'` | ✅ |
| API-04 | Демон Finam | `finam_collection_enabled()` (try/except); пропуск цикла | ✅ |
| API-05 | UI-переключатели | `makeCollectionRow` в `lib.js`; блок «Сбор данных через API» в табе «Настройки»; cookie + `saveSettingsToServer` | ✅ |
| API-06 | Скрипка баннера | Источник с выключенным сбором не рендерится (строки капитала/таблицы); пара T+F итог — только при 2+ активных | ✅ |

## Применение фронтенда

- `static/js/report.js` → `populateSettingsPane` (таб «Настройки»)
- `static/js/lib.js` → `makeCollectionRow`, `saveSettingsToServer`,
  `getSetting(key,'1')`
- `static/js/invest_banner.js` → `COLLECTION_KEY` map + фильтр `presentSources`

## Проверка (prod 217.114.8.5:10405)

1. POST `/api/user_settings/<device>` `invest_collection_finam_enabled=0`
   → флаг в инвест-БД `0` ✓; возврат к `1` ✓.
2. Лог `wclock5-finam-inv` при `0` — пропуск цикла; сбор Finam останавливается,
   Tinkoff не затронут.

## Связи

- Конвенции: `docs/02_project/conventions.md` §4 (панели), новый раздел
  «Настройки сбора» (§10).
- Код: `app.py`, `invest_db.py`, `parsers/invest/tinkoff_invest_daemon.py`,
  `parsers/invest/finam_invest_daemon.py`, `lib.js`, `report.js`, `invest_banner.js`.
- Эпик: `docs/02_project/epics/EPIC_panels_uix.md` (UI-04, скрытие источника).

## Лист изменений

- **0.1** · 2026-09-03 — создан: API-01..06, решение, проверка на проде.