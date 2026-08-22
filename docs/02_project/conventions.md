# Конвенции WClock5

- ver: 0.1
- updated: 2026-08-22
- scope: деплой, инвест-данные, графики, панели
- источник: сессия 21–22.08.2026

## 1. Деплой на прод

Прод: `root@217.114.8.5`, `/var/www/wclock5.startupassist.ru`.
Compose-сервисы: `wclock` (app), `invest-parser`, `finam-invest-parser`
(контейнеры `wclock5-app`, `wclock5-inv`, `wclock5-finam-inv`).
Приложение на хосте: **порт 10405** (`localhost:8000` — чужой сервис,
не использовать для тестов).

- JS/CSS: scp → `/tmp` → `node --check` → cp в `static/…`; локального node нет.
- Python: scp напрямую + рестарт затронутых контейнеров
  (`docker compose restart wclock invest-parser finam-invest-parser`).
- HTML/Jinja: правки через шаблоны; статика версионируется глобалом
  `surl()` (`?v=mtime`) + `no-cache` у HTML → кэш обновляется сам.
- systemd-сервисы хоста (вне compose): `tg-turnover`
  (`parsers/telegram/tg_turnover_daemon.py`).

## 2. Инвест-данные

- Время — **всегда числовой `ts_epoch`** (Unix UTC) в БД; ISO-строки только
  как источник парсинга (`invest_repo.parse_ts`). Строковые сравнения
  дат запрещены (класс багов −3ч/−6ч).
- Mediation-слой — `invest_repo.py` (DTO, запись/чтение, retention,
  миграции идемпотентны); `invest_db.py` — shim совместимости.
- Демоны пишут через repo, читают API-эндпоинты через repo.
- Интервал опроса портфелей: 10с днём (08:00–24:00 МСК) / 60с ночью.
- **Оборот = только стратегия**: API счёта содержит чужие алго-потоки и
  не пригоден для фильтрации. Источник истины — Telegram-канал бота
  «Сделки Бота» → таблица `strategy_summary` (последняя запись дня на
  источник; дубли строк от редактирования поста — норма).
- Комиссия в `/api/invest/turnover`: Tinkoff — 0,02% плоско;
  Finam — тариф «Трейдер»: брекетная ставка дневного оборота
  (`FINAM_MOEX_TIERS`) + урегулирование (МосБиржа 0,03% / СПБ 0,01%);
  стратегия Финама торгует на СПБ.

## 3. Графики (Chart.js)

- Позиции точек — `scale.getPixelForValue(index)` по данным;
  `getPixelForTick()` — только для тиков оси (прорежены autoSkip'ом,
  индексы НЕ совпадают с точками — класс багов «линия у края»).
- Всё, что зависит от текущего времени (линия «сейчас», тултип),
  либо считается при каждом рендере, либо обновляется таймером
  (`chart.update('none')` раз в минуту); деление на ноль/isFinite проверять.
- DPI: пер-панельные слайдеры (`chartDpiValue('invest'|'weather')`,
  `dpiFont()`, `setupCanvasForDPR`), события `weatherDpiChange`,
  `investDpiChange`; слушатели регистрировать ОДИН раз на верхнем уровне,
  не внутри обработчиков ресайза (иначе накапливаются).
- Слушатели событий графиков: jQuery-namespaced
  (`$(document).on('panelTempRangeChange', …)`).

## 4. Панели (размещение и показ)

- Реестр панелей `PANEL_IDS` + дефолты `PANEL_CONFIG_DESKTOP/TABLET`
  (`static/js/panel_configs.js`); геометрия и видимость per-device_id:
  localStorage `wclock_panels` + сервер `/api/panel_config/<device_id>`.
- Edit-mode (кнопка «Настройка панелей»): drag за шапку, ресайз за угол,
  show/hide через модалку панелей (`lib.js`); сброс к дефолту, export/import.
- Перетаскиваемые элементы UI — см. конвенцию
  `01.lab/00_manifest/general_rules.md` §8 (сохранение позиции в куки с
  префиксом приложения, клампинг, порог drag/click 5px, Pointer Events).
  Референс: легенда investChart (`wclock_invest_legend_pos`).
- z-index слоёв панелей: обычные ~10–100; поверх — по логике приложения
  (панель управления выше всех).

## Лист изменений

Версии `X.Y`. Новые записи — сверху.

- **0.1** · 2026-08-22 — первичная версия: деплой (порт 10405, surl),
  инвест-данные (ts_epoch, mediation, оборот=стратегия, тарифы комиссий),
  графики (getPixelForValue vs тики, DPI-слушатели), панели (конфиги,
  куки-позиции, drag&drop).
