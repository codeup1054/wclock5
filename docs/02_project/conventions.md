# Конвенции WClock5

- ver: 0.8
- updated: 2026-09-18
- scope: деплой, инвест-данные, графики, панели (в т.ч. browser-зоны), паттерны, cqi-скейлинг, минутные свечи, авто-refresh, настройки сбора через API, демоны данных, медиатор данных, промпт-рецепты
- источник: сессия 21.08–18.09.2026

## 0. Промпт-рецепт после задачи

После **завершения любой задачи** (правка визуала, логики, деплой) ассистент
выводит в конце ответа **самый короткий промпт**, которым эту задачу можно
повторить/воспроизвести одной командой (токен `пп`).

Формат: одна строка `> <промпт>` под основным ответом. Промпт должен
содержать: файл/модуль, что изменить и (если применимо) целевую величину —
без лишнего контекста.

Пример после выравнивания маркеров:

> Выровняй начальный и конечный маркеры капитала по левому краю меток оси Y XAU. В `PeriodLabelsPlugin` (`invest_chart.js`) установи X-позицию `LABEL_RIGHT_X` = `scales['y_xau'].left` (fallback — `chartArea.left`).

### 0.1 Несколько последних задач (N)

Правило §0 действует для последней задачи. Дополнительно, по запросу
`> N` (или `> N промптов`), ассистент выводит **список последних N
решённых задач** — каждый пункт одной строкой `> …` с самым коротким
промптом/сутью. Список идёт от свежей задачи к более ранней (LIFO), N —
количество последних задач, например `> 5` → 5 последних рецептов.

Цель: каждая доработка превращается в переиспользуемый рецепт без разбора
истории сессии.

### 0.2 Фиксация в беклоге

После **завершения задачи** помимо вывода рецепта (§0):
1. **Зафиксировать статус** задачи в свежем беклоге
   (`docs/02_project/backlogs/backlog_YYYYMMDD.ldn.md`): пометить задачу
   `✅` (напр. `TICK-01 ✅ (H) — …`).
2. **Записать самый оптимальный промпт** для её решения — компактной
   строкой в записи задачи (или в отдельном поле `промпт:`), чтобы
   задачу можно было воспроизвести одной командой без разбора кода.
3. Если беклог дня уже закрыт/перенесён — занести запись в актуальный
   открытый беклог либо добавить задачу с рецептом в новый.

Формат промпта внутри беклога — тот же, что в §0 (одна строка `> …`),
с указанием файла/модуля и сути правки.

## 1. Деплой на прод

Прод: `root@217.114.8.5`, `/var/www/wclock5.startupassist.ru`.
Compose-сервисы: `wclock` (app), `invest-parser`, `finam-invest-parser`
(контейнеры `wclock5-app`, `wclock5-inv`, `wclock5-finam-inv`).
Приложение на хосте: **порт 10405** (`localhost:8000` — чужой сервис,
не использовать для тестов).

Команды деплоя (токены `пп`):
- **`пп -дп`** — деплой prod: `bash sh/devops.sh static` на VPS 217.114.8.5
- **`пп -дд`** — деплой dev: локальный деплой без VPS

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
- Комиссия в `/api/invest/turnover` и отчёте: Tinkoff — 0,02% плоско;
  Finam — тариф «Трейдер n6»: брекетная ставка дневного оборота
  (`FINAM_MOEX_TIERS`: до 1М 0,025 / 1–5М 0,015 / 5–30М 0,01 / 30–100М 0,005 /
  100–250М 0,0025 / >250М 0,001 %) + урегулирование сделок СПБ 0,01%
  (`FINAM_SETTLE_SPB`); стратегия Финама торгует на СПБ, поэтому ставка в
  отчёте = брокерский брекет + 0,01% (пример: 30–100 млн → 0,015%).
  Урегулирование МосБиржи 0,03% — только для мосбиржевых сделок (`app.py`).

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

**Автономные элементы инвест-баннера — отдельные панели** (каждая — в
`PANEL_IDS`, в `panel_configs.js`, со своим переключателем в «Настройках»):

| Панель | id | Содержимое |
|--------|----|-----------|
| Капитал | `invest_banner_capital` → `#invest_banner_capital_content` | строки капитала + оборот + бары активов |
| Таблица | `invest_banner_table` → `#invest_banner_table_content` | таблица периодов |
| Итого | `invest_banner_total` → `#invest_banner_total_content` | только суммарный капитал (без подписей) |

Инлайн-«Итого» в Капитале показывается только когда панель «Итого» скрыта
И активны 2+ источника; при включённой панели «Итого» — инлайн дубль убирается.

**Единая модалка Отчётов** (`report.js`) — табы Инвестиции / Ошибки бота /
Настройки; открытие по `☰` (`#panels-list-btn`) и запросу `window.Report.open(tab)`.
Кнопки `O` больше нет.

**Настройки в 2 столбца** (`lib.js` `populateSettingsContent`): контейнер
`settings-container` — grid `1fr 1fr`; внутри два div-столбца
`settings-col-left` / `settings-col-right`. Заполнение построчно в порядке
следования: **первая половина строк** → первый столбец, **вторая** → второй
(`Math.ceil(rows.length/2)`). Профили (`panel-profiles-row`) и заголовки
(`settings-section-title`) — на всю ширину (`grid-column: 1 / -1`).
Row-классы `settings-col-first/second` НЕ использовать (удалены).

**Browser-зоны (`#browser_fullscreen`, `#browser_reload`)** — прозрачные
клик-зоны действий браузера, НЕ clock-panel:

- `clock-panel` не навешивается (сплошная рамка/`overflow:hidden` ломают
  прозрачность и собственные клики). Зарегистрированы в `PANEL_IDS` +
  `PANEL_CONFIG_DESKTOP/TABLET`, переключатели — в «Настройках».
- Обычный вид: почти невидимые (opacity 0.35, фон `rgb(255 255 255/9%)`,
  рамка `2px dashed rgb(255 215 0/10%)`) — зона видна, но не «шум ит».
- Edit-mode: зоны поверх панелей (`z-index: 150`, `display:block !important`),
  оранжевая dashed-рамка, drag (`initDrag`) + resize (`initResizeHandle`,
  8 ручек видны в edit-mode).
- Действия зон (reload/fullscreen) в edit-mode отключены (`index.js` +
  `initDrag` гасит клик после перетаскивания).
- **Подавление клика после drag/resize — ТОЛЬКО для `browser_reload`**
  (иначе после движения срабатывает `hardReload`): capture-слушатель `click`
  на документе гасит событие, если `suppressClickTarget === panel`. Флаг
  ставится только при реальном движении (порог 3px, `moved` в
  `onDragMove`/`onResizeMove`), простой клик не гасится.

## 5. Паттерны штриховки (CanvasPattern)

### 5.1 Функции

- `hatchPattern(color, angleDeg, alpha)` — создаёт CanvasPattern с штриховкой.
  Ключ кеша: `color|angleDeg|alpha`. Тайл рисуется 1 раз, переиспользуется.
  `invest_chart.js` (buildTgldDatasets).
- `rgba(base, alpha)` — конвертирует hex `#rrggbb` → `rgba(r,g,b,alpha)`.
  Без конвертации hex возвращает цвет без alpha (баг). `invest_chart.js`.
- `makeLayer(name, data, color, stack, axisId, dashed, angle, hatchAlpha)` —
  обёртка для стекового датасета с паттерном; `hatchAlpha` — прозрачность
  штриховки слоя (LQDT → 0.99). `invest_chart.js` (buildTgldDatasets).

### 5.2 Параметры паттерна

| Параметр | Значение | Формула / Примечание |
|----------|----------|----------------------|
| tileW × tileH | 25 × 25 | `round(SPACING / sin(45°))` ≈ 25.5 → 25 |
| SPACING | 18 | Расстояние между линиями (px на экране) |
| lineWidth | 1 | На экране 1px |
| dpr | `devicePixelRatio / 4` | Баланс чёткости и производительности |
| HATCH_ALPHA | 0.45 | Прозрачность линий штриховки (дефолт) |
| LQDT alpha | 0.99 | Штриховка LQDT почти непрозрачная |
| FILL_ALPHA | 0 (clearRect) | Фон тайла — прозрачный |
| cache key | `color\|angleDeg\|alpha` | Одно создание на сессию |

### 5.3 Углы наклона

| Источник | Угол | Направление |
|----------|------|-------------|
| Tinkoff | -45° | Сверху-слева вниз-вправо `\` |
| Finam | 45° | Снизу-слева вверх-вправо `/` |

### 5.4 Стек: порядок слоёв

Layerdown-заливка стека: каждый слой заливается к **нижестоящему**
(`fill: '-1'`), а не к origin — поэтому штриховка LQDT идёт от уровня TGLD,
а не от нуля. Нулевые участки (нет позиций) не штрихуются
(`spanGaps: false` + доля 0, а не null).

| Слой | Заливка | Цвет | Примечание |
|------|---------|------|-----------|
| TGLD (низ) | сплошная, `fill: origin` | T: `#2cba99` @ 30% · Ф: `#4a7bd8` @ 12% | без паттерна, дно стека |
| TMON | штриховка `fill: '-1'` | оранжевый `rgba(255,120,0)`, alpha 0.45 | от уровня TGLD |
| LQDT (верх) | штриховка `fill: '-1'`, alpha 0.99 | розовый `rgba(220,100,140)` | от уровня TGLD+TMON |

Контуры стека: `borderWidth: 0.5`, `borderColor: rgba(color, 0.5)`, сплошные.
Финам TGLD контур — тот же синий `#4a7bd8` (alpha 0.9).

### 5.5 Легенда: 3 столбца

| Столбец 1 (Финам) | Столбец 2 (Тинвест) | Столбец 3 (Тикеры/прочее) |
|--------------------|--------------------|---------------------------|
| Ф:LQDT, Ф:TMON, Ф:TGLD, Ф:₽, Ф:% | T:LQDT, T:TMON, T:TGLD, T:₽, T:% | XAU, TGLD@, 100% |

Группировка: `Ф:` / `Finam*` → столбец 0; `Т:` / `Tinkoff*` → столбец 1;
остальное → столбец 2.

Collapse/expand: cookie `wclock_invest_legend_collapsed`.

### 5.6 Быстрый деплой (подбор параметров)

```bash
bash sh/deploy_js.sh [file]
```

Деплоит JS/CSS файл на VPS с проверкой MD5. По умолчанию — `invest_chart.js`.

### 5.7 Применение в других проектах

Для воспроизведения штриховки достаточно промпта + таблицы §5.2.
Полный код: `invest_chart.js` → `hatchPattern`, `makeLayer`, `buildTgldDatasets`.

### 5.8 Легенда: drag&drop, touch, cookie

**Архитектура.** Кастомный плагин `inlineLegendPlugin` (не встроенный
`legend` Chart.js). Рисуется на canvas после тултипа.

**Стиль:**
- 3 столбца: Финам | Тинвест | Тикеры/прочее
- Шрифт: 12px bold, auto-resize (уменьшается если не влезает)
- Swatch: 12×2px, gap между строками 12px, между столбцами 32px
- Фон: `rgba(18,20,24,0.78)`, кнопка collapse `◀`/`▶`

**Touch-интеракция (планшет):**

| Параметр | Значение | Назначение |
|----------|----------|------------|
| drag threshold | 5px | Минимальное смещение для начала drag |
| hit area | `_legendRect` | Жесто-зона для захвата |
| collapse button | 20×20px | Достаточно для пальца |

Порог 5px разделяет click (переключение серии) и drag (перемещение).
Это критично для планшета: случайный жест не переключит серию.

**Cookie:**

| Cookie | TTL | Содержимое |
|--------|-----|-----------|
| `wclock_invest_legend_pos` | 1 год | `{x, y}` — позиция |
| `wclock_invest_legend_collapsed` | 1 год | `0/1` — свёрнута/развёрнута |
| `wclock_invest_legend` | 1 год | `{label: hidden}` — видимость серий |

**Клампинг позиции:**
`pos.x = clamp(0, chart.width - totalW)`, аналогично по Y.
Легенда не выходит за границы canvas.

**Подавление клика после drag:**
После перетаскивания (`_legendDragMoved = true`) клик игнорируется
до следующего `pointerdown`. Предотвращает случайное переключение
при отпускании пальца.

**Группировка столбцов:**

| Столбец | Префикс метки | Примеры |
|---------|---------------|---------|
| 0 (Финам) | `Ф:`, `Finam*` | Ф:LQDT, Finam, ₽ |
| 1 (Тинвест) | `Т:`, `Tinkoff*` | T:TGLD, Tinkoff, % |
| 2 (Тикеры) | остальное | XAU, TGLD@, 100% |

**Референсы:**
- `inlineLegendPlugin` → `invest_chart.js:~1370`
- `toggleLegendDataset` → `invest_chart.js:~1565`
- `attachLegendDrag` → `invest_chart.js:~1612`

## 6. Контентный скейлинг панелей (cqi)

Вместо `transform:scale` хака — чистый CSS через container query units (`cqi`).

**Паттерн** (эталон: `#seconds_panel`, `#sun_panel`, `#date_panel`):

```css
.panel {
    container-type: inline-size;
    container-name: self;
}
.child-element {
    font-size: Ncqi;         /* относительно контейнера */
    line-height: L;          /* нормализованная высота строки */
}
```

**Текущие панели (cqi):**

| Панель | Элементы | Значения | Статус |
|--------|----------|----------|--------|
| `#seconds_panel` | `#seconds` | `85cqi` → `55cqi` (настр.) | ✅ |
| `#sun_panel` | `#sun` flex 100%, `#sunrise/#daylight/#sunset` | `10cqi` | ✅ |
| `#date_panel` | `#day`, `#month`, `#weekday` | `60/25/32cqi` | ✅ |
| `#invest_banner_capital` | `.banner-capital-line`, `.banner-turnover-block` | `13cqi` / `4.0cqi` (настр.) | ✅ |
| `#invest_banner_table` | `[class*="banner-td-"]` | `2.7cqi` (настр.) | ✅ |
| `#invest_banner_total` | `.banner-total-only` | `12.5cqi` | ✅ |

**Баннерные панели — контейнеры** (`container-type: inline-size` на
`#invest_banner_capital/_table/_total`): строки капитала/оборота, бары активов
и таблица масштабируются по ширине панели. Фон/структура — px (`.asset-bar`).

**Остальные** (clock_panel, moon_panel, wind_cond_precip_panel, press_humidity_temp_panel)
пока в `PANEL_CONTENT_SELECTORS` / `PANEL_BASE_SIZES` — поэтапно перевести.

**Правила:**
- Убрать панель из `PANEL_CONTENT_SELECTORS` и `PANEL_BASE_SIZES` (`panel_resize.js`)
  после перевода на cqi.
- Проверять паттерн через ресайз в браузере (drag за угол в edit-mode).
- После деплоя — MD5-проверка CSS.

## 7. Инвест-панель: живой конец, авто-refresh, данные свежести

### 7.1 Живой конец диапазона

Тумблер «По: сейчас» в модалке period-range-modal (`control_panel.js`).

| Значение `end` | Поведение | Серверный URL |
|----------------|-----------|---------------|
| `'live'` | График заканчивается на текущем времени | `end_ts=live` (→ `_int_or_none` → None → без верхней границы) |
| timestamp | Фиксированная верхняя граница | `end_ts=<timestamp>` |

Фикс: при снятии чекбокса поле «по» разблокируется и подставляется `Date.now()`.

### 7.2 Авто-refresh (гибрид)

Таймер обновления графика при живом конце (`invest_chart.js` → `control_panel.js`).

| Компонент | Поведение |
|-----------|-----------|
| График investChart | Обновляется **только при `end='live'`** |
| InvestBanners | Обновляются **всегда** (`window.InvestBanner.update()`) |
| Интервал | Настраиваемый (30/60/120с) через select в period-range-modal |
| Настройка | `invest_autorefresh` (cookie) |

### 7.3 Индикатор свежести данных

Код: `showDataFreshness()` → `invest_freshness` div в invest_panel (`invest_chart.js:~2005`).

| Интервал | Порог `maxAgeMin` | Цвет при превышении |
|----------|-------------------|---------------------|
| `minute` | 3 мин | `#f44336` (красный) |
| `hour` | 10 мин | `#f44336` |
| `day` | 120 мин | `#f44336` |

Формат: `⚠ HH:MM (N мин)` — красный, жирный. Если свежий — `✓ HH:MM` — серый.

## 8. Минутные свечи: слой portfolio_min

**Таблица** `portfolio_min` — 1-минутные OHLCV-свечи, детальный анализ за 30 дней.

| Константа | Значение | Назначение |
|-----------|----------|------------|
| `RETENTION_RAW_DAYS` | 1 | Хранение сырых 10с снапшотов |
| `RETENTION_MIN_DAYS` | 30 | Хранение минутных свечей |
| `RETENTION_CANDLE_DAYS` | 120 | Хранение часовых свечей |

**Схема `portfolio_min`:**

```sql
CREATE TABLE IF NOT EXISTS portfolio_min (
    timestamp TEXT, ts_epoch INTEGER, source TEXT,
    open REAL, high REAL, low REAL, close REAL, volume INTEGER,
    tgld_value REAL, tgld_total REAL, tmon_value REAL, lqdt_value REAL,
    UNIQUE(ts_epoch, source)
);
CREATE INDEX IF NOT EXISTS idx_portfolio_min_epoch_source
    ON portfolio_min(ts_epoch, source);
```

**apply_retention() — двухступенчатый:**

1. **Шаг 1: raw → min** — сырые 10с снапшоты → 1-мин свечи (OHLCV).
   - Бакет: `ts_epoch // 60 * 60` (aligned to minute).
   - INSERT ON CONFLICT DO UPDATE: max(high), min(low), close=excluded, volume+=excluded.

2. **Шаг 2: min → hourly** — минутные свечи старше 30 дней → часовые.
   - Бакет: `ts_epoch // 3600 * 3600`.
   - Аналогичный UPSERT.

3. **Чистка**: DELETE raw (старше raw_cutoff), min (старше min_cutoff), hourly (старше candle_cutoff).

**read_history() — приоритет raw > min > hourly:**

- Читает `portfolio_positions` (raw), `portfolio_min`, `portfolio_hourly`.
- Слияние по ключу `(ts_epoch, source)`: raw перекрывает min, min перекрывает hourly.
- Все три таблицы участвуют в fallback (`if not raw_rows and not candles and not min_candles`).

**Backfill не нужен** — 1-мин свечи копятся только с момента деплоя (старые данные не восстановить).

## 9. Chart.js: defensive update pattern

При in-place обновлении графика (модификация `investChart.data.datasets`) **обязательно**
вызывать `investChart.update('none')` после всех изменений.

**Причина:** без `update()` Chart.js не пересчитывает оси (scales). При mouse event
tooltip обращается к несуществующей оси → `TypeError: Cannot read properties of null
(reading 'getLabelAndValue')`.

**Паттерн** (`invest_chart.js:~1440`):

```js
// Обновление датасетов in-place
investChart.data.datasets[0].data = newData;
// ... push/pop datasets ...

// Обязательно!
investChart.update('none');
```

**Дополнительно:** defensive `try/catch` в tooltip callbacks для защиты от race conditions.

## 10. Настройки сбора через API (Tinkoff / Finam)

Серверное отключение сбора данных отдельно по брокерам, применяется демонами
**без рестарта** (читают каждый цикл).

**Ключи** (таблица `settings` инвест-БД `invest_portfolio.db`):

| Ключ | Брокер | False | Default |
|------|--------|-------|---------|
| `invest_collection_tinkoff_enabled` | Tinkoff | `'0'` | `'1'` (нет записи = включено) |
| `invest_collection_finam_enabled` | Finam | `'0'` | `'1'` |

**Маршрутизация:** эти ключи НЕ хранятся в `user_settings` БД как обычные
настройки — `app.py` (`_get/_write_invest_collection_settings`) направляет их
в инвест-БД `settings` через `/api/user_settings/<device_id>` (GET/POST).
Проверено: POST `invest_collection_finam_enabled=0` → флаг в инвест-БД `0`,
GET возвращает из инвест-БД.

**Демоны** (`parsers/invest/tinkoff_invest_daemon.py`,
`finam_invest_daemon.py`): при ключе `'0'` — печать `⏸️ Сбор данных через …
отключён — цикл пропущен` и пропуск тела цикла (fetch/save/retention/trades).
`get_setting_value(key, default)` / `finam_collection_enabled()` (try/except).

**Фронтенд:** переключатели в табе «Настройки» единой модалки (`lib.js`
`makeCollectionRow`); состояние в cookie `getSetting(key,'1')`, на сервер —
`saveSettingsToServer`. При выключенном сборе источник скрыт в баннере
(`presentSources` фильтр по `COLLECTION_KEY`).

## 11. Демоны данных: правки на сервере (tg_turnover и др.)

Демоны (`parsers/telegram/tg_turnover_daemon.py` и др.) крутятся в systemd
**на хосте**, не в docker-контейнере wclock5-app. Правила:

1. **Деплой демона** — `scp` напрямую
   `root@217.114.8.5:/var/www/wclock5.startupassist.ru/parsers/.../` →
   `systemctl restart <service>`; проверка статуса через `journalctl -u <svc>`.
2. **Новый пост не должен перезатираться старым.** `iter_messages(limit=N)`
   возвращает посты от новых к старым; при записи итога дня в
   `strategy_summary` (day, source) — обновлять строку, только если
   `msg_ts` нового сообщения **новее** `ts_epoch` существующей записи
   (иначе устаревший внутридневной пост перезапишет свежий).
3. **Рабочая БД = `parsers/invest/invest_portfolio.db`** (bind-mount на хосте
   → в контейнере `/app/parsers/invest/invest_portfolio.db`, это один файл).
   Проверка данных: `docker exec wclock5-app python3 -c "…"`.

## 12. Медиатор данных (Mn-21)

Один POST `/api/data_mediator` в минуту вместо N периодических GET — дельта-шина
панели (эпик `EPIC_mediator_data.md`, ADR `0006_mediator_proxy_incremental.md`).

**Протокол (сервер `app.py: api_data_mediator`):**
- body: `{"v": {секция: токен клиента}, "params": {секция: {…}}, "write": {секция: {…}}}`.
- `v` пуст → клиент «с нуля» → все секции в `changed`.
- ответ: `{changed: {секция: payload}, tokens: {секция: токен}, writes, ts}`.
- payload в `changed` несут **полные** данные секции — клиент рисует из них
  без повторного GET к `/api/*`.
- Токен секции = SHA-256(sort_keys JSON), 16 hex, для `invest.history` — `str(_latest_epoch)`.
- Чтение — `_DATA_MEDIATOR_READERS`; записи — `_DATA_MEDIATOR_WRITERS`
  (`battery: {device_id, value}`); гранулярность записей `_DATA_MEDIATOR_WRITE_INTERVAL`
  (`battery` 60с).
- **Инвест-секции читаются теми же payload-хелперами, что GET**
  (`_invest_history_payload`/`_invest_tickers_payload`/`_invest_turnover_payload`) —
  один источник, медиатор и `/api/invest/*` не расходятся.

**Клиент (`static/js/panel_mediator.js`):**
- `PanelMediator.subscribe(sect, fn, {params})` — подписчик + провайдер параметров;
  в `v` уходят только подписанные секции.
- Смена параметров провайдера → инвалидация токена → force delta (полный payload нового диапазона).
- API наружу: `subscribe`, `getLatest(sect)`, `getLatestAt(sect)`, `invalidate(sect)`, `write(sect, payload)`, `healthy()`.
- Токены в localStorage `wclock5_mediator_tokens`; опрос 10с (единый тик дашборда,
  POLL_MS); пропуск при `document.hidden`; при недоступности `healthy=false` и
  виджеты возвращаются к GET-fallback.
- **Маршрут секций**: weather→`window.renderWeatherData`; charts_data→`window.renderWeatherChart`;
  battery.history→`window.renderBatteryHistory` (battery.js `drawBatteryChart(<массив>)`);
  invest.tickers/turnover/history→InvestBanner + `window.__investTickerCache`/`InvestHistoryCache.primeFromMediator`;
  invest.turnover_details→InvestBanner (тултип блока оборотов); settings→`window.settings`.

**Виджеты (fallback на GET при застое медиатора):**
- invest.history: `InvestHistoryCache.primeFromMediator(interval, period, start_ts, end_ts, raw)`,
  TTL 70с — `get()` отдаёт медиаторный payload без GET.
- invest.tickers: `getLatest('invest.tickers')` → `window.__investTickerCache` + рендер.
- battery: `sendBatteryLevel()` → `PanelMediator.write('battery', {device_id, value})`;
  при недоступности медиатора — старый POST `/api/battery`.

## Лист изменений

Версии `X.Y`. Новые записи — сверху.

- **0.9** ≡ 2026-09-18 - §12 обновление под шаг 2: опрос 10с (POLL_MS, единый
  тик), `getLatestAt`, weather/settings через медиатор (GET — fallback), новая
  секция `invest.turnover_details` (strategy_summary + «Тариф процентный» из
  bot_events; в клиенте — тултип блока оборотов), serulerный TTL тикеров 30с.

- **0.8** ≡ 2026-09-18 - §12 медиатор данных: invest-секции
  (history/tickers/turnover) в `/api/data_mediator` через общие payload-хелперы,
  клиентский `PanelMediator` (подписки, инвалидация по params, write), перевод
  invest_banner/invest_chart/battery на медиатор с GET-fallback.

- **0.7** · 2026-09-16 — §11 демоны данных: деплой демонов на хосте через
  scp+systemctl (не docker); правило «новый пост не перезатирается старым»
  в strategy_summary (проверка msg_ts > ts_epoch перед UPDATE); рабочая БД
  `parsers/invest/invest_portfolio.db` — bind-mount хоста в контейнер.
- **0.6** · 2026-09-09 — §4 панели: настройки в 2 div-столбца (grid,
  построчное заполнение первой/второй половиной); browser-зоны
  (`#browser_fullscreen`/`#browser_reload`) как отдельная подтема — вид,
  edit-mode (drag/resize, рамка), подавление клика после перетаскивания
  только для reload (порог 3px).
- **0.5** · 2026-09-08 — §0 промпт-рецепт: после завершения любой задачи
  выводить самый короткий промпт для её воспроизведения; §0.1 — по `> N`
  выводить список последних N решённых задач (по одной строке `> …`);
  §0.2 — фиксировать статус задачи в беклоге и записывать в неё самый
  оптимальный промпт.
- **0.5** · 2026-09-03 — §5 штриховка стека: `fill: '-1'` (к нижестоящему
  слою, не к origin), HATCH_ALPHA 0.45, LQDT alpha 0.99, TGLD сплошная
  (T 30%, Ф #4a7bd8 12%), датасеты tmon/lqdt — 0 при нулевых долях
  (не null); `hatchPattern`/`makeLayer` принимают alpha; кеш-ключ alpha.
- **0.4** · 2026-09-03 — §4 панели: отдельные панели инвест-баннера
  (Капитал/Таблица/Итого), единая модалка Отчётов (табы, `☰`); §6 cqi —
  баннерные панели-контейнеры; §10 настройки сбора через API
  (`invest_collection_*`, читаются демонами без рестарта).
- **0.3** · 2026-08-31 — §6 cqi-скейлинг панелей, §7 инвест-панель (живой конец,
  авто-refresh, свежесть данных), §8 минутные свечи (portfolio_min, 30 дней),
  §9 Chart.js defensive update pattern.
- **0.2** · 2026-08-25 — §5 паттерны штриховки: CanvasPattern (hatchPattern,
  rgba hex-конвертация, кеш), параметры тайла (25×25, SPACING 18, dpr/4),
  углы 45°/-45°, порядок стека (LQDT→TMON→TGLD), легенда 3 столбца,
  быстрый деплой (deploy_js.sh), §5.8 легенда drag&drop/touch/cookie.
- **0.1** · 2026-08-22 — первичная версия: деплой (порт 10405, surl),
  инвест-данные (ts_epoch, mediation, оборот=стратегия, тарифы комиссий),
  графики (getPixelForValue vs тики, DPI-слушатели), панели (конфиги,
  куки-позиции, drag&drop).
