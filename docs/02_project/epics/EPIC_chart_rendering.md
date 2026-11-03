---
title: Эпик — Отрисовка графиков: производительность и ловушки
fnd: GEN
typ: EPIC
ver: 0.5
updated: 2026-11-03
status: ✅
---
# Эпик — Отрисовка графиков: производительность и ловушки

Правила и проверенные решения по отрисовке инвестиционных графиков Chart.js
(портфель/тикеры) в wclock5 и hft: не допускать «зависания» рендера,
отсутствия линий и «застрявшего» обновления. Собран опыт из инцидента
31.08.2026.

## Контекст

31.08.2026 `updateInvestPlot()` на классике (wclock5, порт 10405) выдавал
в консоли `[InvestPlot] Timeout 30s, isUpdating reset`, затем на каждый клик
`Update already in progress, skipping`, и портфели Тинькофф/Финам не
отрисовывались. Причина — не логика/данные, а **взрыв числа точек** при
сочетании мелкого интервала и длинного периода. Разбор и фикс применимы к
любому Chart.js-графику.

## Корень проблемы

- `aggregateData()` заполняет пропуски (`gap > intervalMs*1.5`) интерполяцией
  до полного минутного разрешения по ВСЕМУ периоду.
- Клик по кнопке интервала `1M` (minute) при периоде по умолчанию `-35 day`
  → 49 663 точки для портфеля + по ~49 000 точек на каждый тикер
  (`/api/invest/tickers` отдавал 9 MB).
- Итог ~200 000 точек в Chart.js блокирует главный поток на десятки секунд
  → срабатывает 30-секундный таймер-предохранитель, флаг `isUpdating` до его
  сброса остаётся `true`, все последующие клики отбрасываются как
  «in progress». Портфели не рисуются.

## Задачи эпика

| Код | Задача | Результат | Статус |
|-----|--------|-----------|--------|
| GRD-01 | Кап точек в `aggregateData` | `MAX_AGG_POINTS = 3000`, прореживание с сохранением последней точки | ✅ |
| GRD-02 | Кап тикеров на бэкенде | `MAX_TICKER_POINTS = 3000` (`app.py` классика + `hft/app.py`) | ✅ |
| GRD-03 | Проверка «застрявшего» `isUpdating` | Нормальные комбо под капом не блокируют основной поток | ✅ |
| GRD-04 | Документация правил отрисовки | Раздел «Правила» ниже | ✅ |
| GRD-05 | Порт фикса в hft | `invest_chart_helpers.js` + `hft/app.py` + cache-bust `.4` | ✅ |
| GRD-06 | Плагин apiErrorPoints | Замена вертикальных красных пунктиров на точки на верхней оси X; ховер-тултип (дата + % скачка); хук afterEvent + hit-test radius 7px; destroy чистит тултип | ✅ |
| GRD-07 | Метки периода для XAU | PeriodLabelsPlugin: `s.fmt` для кастомного формата; XAU fmt `(v/1000).toFixed(3)`; метки в loadTickersToChart из first/last valid price | ✅ |
| GRD-08 | Линия 100% полупрозрачная белая | `rgba(255,255,255,0.85)`, `borderDash [8,6]`; в обоих местах (создание и обновление) | ✅ |
| GRD-09 | Настройка цветов тикеров в редакторе параметров | `ChartTheme` группа «Цвета тикеров» (`tgld/xau/usd/brent`); `colorKey` + `tickerColor(cfg)` в `invest_chart.js`; `themeColor(key,def)` + слушатель `chartThemeChange` в `invest_banner.js`; порядок групп задан явно (`groupOrder`): 1-й столбец — `Шрифты`, `Толщины линий`, `Настройки графика`; 2-й — `Штриховка`, `Цвета тикеров`, `Цвета линий` | ✅ |
| GRD-10 | Метки периода USD/Brent | источники `y_usd` (`#3ba3ff`) и `y_oil` (`#556B2F`), `fmt: v.toFixed(2)` | ✅ |
| GRD-11 | Метки скрытых серий не рисуются | `PeriodLabelsPlugin` skip при `!chart.isDatasetVisible`; матч источника и датасета по `datasetLabel` | ✅ |
| GRD-12 | Цвет Brent — болотный | `#556B2F` в chart+banner (wclock+hft) | ✅ |
| GRD-13 | Полоса «Spread» TGLD@ на графике | `MorningGapPlugin` — столбики утреннего гэпа в нижней полосе (`bandH = max(28, area.height*0.16)`), знак → `color.jumpUp/jumpDown`, пунктир среднего `color.jumpAvg`; данные `/api/invest/ticker/TGLD@/morning_gap` (wclock) / `/api/hft/ticker/TGLD@/morning_gap` (hft) | ✅ |
| GRD-14 | Свечи USD/RUB вместо одной точки | `parsers/invest/fx_candles.py`: `MarketDataService/GetCandles` (figi `BBG0013HGFT4`, USD000UTSTOM), запись **в обе БД** — `fx_rates` (портфельная) и `last_prices` (её читает график); автообновление из `tracked_tickers_daemon` (`update_once(minutes=120)`); бэкфилл 8 недель смешанными интервалами (1min 0–2 дня, 5min 2–14, hour 14–56) | ✅ 03.11 |
| GRD-15 | Масштаб ₽-осей от первого ненулевого значения | `buildScales`/`recomputePortfolioAxis`: **раздельные** диапазоны `y_portfolio` и `y_finam` (Finam ~8.5 млн против Tinkoff ~57 тыс.), `min = max(0, lo − pad)` без прижатия к нулю; `T+F` в расчёт шкалы не входит | ✅ 03.11 |
| GRD-16 | Сетка X = объединение портфеля и тикеров | `buildGridFromTickers(chart, tickersData, interval, currentTimestamps)`: если бакетов истории < 20, а у тикеров ≥ 20 — ось строится по объединению; значения переносятся по бакету, `chart._midnightTimestamps` синхронизируется | ✅ 03.11 |
| GRD-17 | Портфельные линии не тянутся через пустоту | `spanGaps: false` для `Tinkoff ₽/Finam ₽/T+F ₽/%` — при периоде раньше начала сбора линии нет, а не прямая через пустой участок | ✅ 03.11 |
| GRD-18 | Тултип: дата + время | `title` → `DD.MM.YYYY HH:MM`; таймстемп берётся из `chart.data.timestamps` (а не `_midnightTimestamps`, который отставал после перестройки сетки) | ✅ 03.11 |
| GRD-19 | Период в неделях | `invest_repo._PERIOD_RE` + `_UNIT_SECONDS['week'] = 604800`: `-8 week` больше не откатывается к 35 дням | ✅ 03.11 |
| GRD-20 | Тикер со слэшем в URL | `@app.route("/api/invest/ticker/<base>/<quote>")` + склейка в `api_invest_ticker`: `/api/invest/ticker/USD/RUB` не матчился строковым конвертером Flask (`%2F` декодируется до роутинга) | ✅ 03.11 |
| GRD-21 | Кэш ответов не роняет 404 | `invest_cache_key` нормализует `/` в endpoint (иначе файл `ticker_USD/RUB_…` уходил в несуществующий подкаталог), запись кэша обёрнута в `try` | ✅ 03.11 |
| GRD-22 | Живое XAU без yfinance | `_fetch_xau_from_yahoo_api()` — тот же источник через `query1.finance.yahoo.com/v8/finance/chart/GC=F`, фолбэк после yfinance; образ без пакета больше не теряет XAU | ✅ 03.11 |

## Правила отрисовки (справочник для новых графиков)

1. **Бюджет точек** — не отдавать в Chart.js больше ~3000 точек на серию.
   Кап на клиенте (`MAX_AGG_POINTS`) и на сервере (`MAX_TICKER_POINTS`).
   Прореживание равномерное (`step` по индексам), **последняя точка всегда
   сохраняется** (иначе «запаздывает»/обрезается конец линии).
2. **Главный поток не блокируем** — тяжёлый рендер (50к+ точек) вешает
   вкладку и роняет таймеры. Если нужна высокая детализация — даунсэмпл до
   объёма, рендерящегося за доли секунды.
3. **`isUpdating` — одиночный замок** — до сброса флага в `finally`/`.done`/
   `.fail`/`.always` любые новые вызовы отбрасываются «in progress».
   Рендер должен завершаться существенно быстрее тайм-аута-предохранителя,
   иначе самый первый медленный вызов «убивает» график до перезагрузки.
4. **Масштаб запроса = масштабу показа** — сервер режется по `bucket_size`
   интервала; но при `minute × -35 day` это всё ещё 49к точек. Дополнительный
   кап обязателен для узких интервалов на длинных периодах.
5. **Видимость серий** — портфели Тинькофф/Финам дефолтно `hidden:true`,
   показываются кликом по легенде (состояние в cookie `wclock_invest_legend`
   / localStorage `hft_chart_legend`). Если «линия не видна» — сперва проверить
   рендер (нет ли тайм-аута), затем легенду.
 6. **Диагностика** — при «график не отображается» смотреть в первую очередь
    Console: `Timeout 30s` + `Update already in progress` = блокажа рендера
    (не логика). Симуляция пайплайна в node (`aggregateData` → `validateGraphData`)
    позволяет отделить «данные плохие» от «рендер виснет» без браузера.
7. **Авто-ось схлопывается** — нормированным рядам (`%`) не давать auto-ось
   (`y_pct` без min/max): при малом разбросе (портфель двинулся на ~0.2%)
   Chart.js схлопывает диапазон, и линии `Tinkoff,%`/`Finam,%` выглядят
   горизонтальными. Задавать явный симметричный диапазон с запасом
   (`min: -bound, max: +bound`, floor 0.2), как у `₽`-осей с `portfolioPadding`.
8. **`₽` vs `%` отладка** — если «горизонтальными» становятся только
   `%`-линии, а `₽`-линии (абсолют, с явным min/max) в порядке → проблема
   в авто-шкале нормированной оси, а не в данных.
9. **Метки периода следуют видимости серии** — метки начала/конца/прироста
   (`PeriodLabelsPlugin`) рисуются только для видимых датасетов
   (`chart.isDatasetVisible`); соответствие источника и датасета — по
   `datasetLabel` (по умолчанию = `label`). Скрытая в легенде серия меток не даёт.
10. **Цвета тикеров — из темы** — цвет серии/оси/метки берётся из `ChartTheme`
    (`color.<colorKey>`, группа «Цвета тикеров»), fallback — дефолт в
    `TICKER_REGISTRY`; хелперы `tickerColor(cfg)` (график) и
    `themeColor(key, def)` (баннер). Смена темы → перестройка графика
    (`chartThemeChange`) и перерисовка баннера.
11. **Доп. полоса под графиком** — метрику, не привязанную к основной оси
    (например утренний гэп), рисуем отдельным плагином в собственной полосе
    внизу `chartArea` (`afterDatasetsDraw`, `bandH = max(28, height*0.16)`),
    нормируя по максимуму модуля; знак → `color.jumpUp`/`color.jumpDown`,
    среднее — пунктиром `color.jumpAvg`. Лучшая точка по X ищется по
    ближайшему `_midnightTimestamps`/`data.timestamps`, столбики за
    пределами `chartArea` отбрасываются.

## Числа до/после (проверено 31.08.2026)

| combo | до (точек) | после (точек) |
|-------|-----------|---------------|
| minute / -35 day (портфель) | 49 663 | 2 922 |
| fivemin / -35 day | 9 933 | 2 484 |
| hour / -35 day | 828 | 828 (без изменений) |
| день / -35 day | 36 | 36 |
| тикеры minute / -35 day | ~49 000 (9 MB) | ~2 900 (~0.9 MB) |

## Применение

- **wclock5** классика `static/js/invest_chart.js` + `invest_chart_helpers.js`
- **hft** `hft/static/js/invest_chart.js` + `invest_chart_helpers.js`
- Новые графики (погода, часы, отчёты) — применять п.1–3 бюджета точек.
- Инвест-модуль фреймворка — см. `PROC_graph_approaches.md`.
- Плагины Chart.js: `chart_plugins.js` (apiErrorPoints, PeriodLabelsPlugin)
  — подключаются через `initChartPlugin` в `invest_chart.js:920–929`.
- Цвета тикеров/осей: `static/js/chart_config.js` (`ChartTheme`, группа
  «Цвета тикеров») + `invest_chart.js` (`colorKey`, `tickerColor`) +
  `invest_banner.js` (`themeColor`); hft-копии `chart_config.js`/`invest_chart.js`.
  Cache-bust: wclock — `surl()` (`?v=mtime`), hft — `?v=` в `templates/index.html`.

## Связи

- Конвенции: `wclock5/docs/02_project/conventions.md` §3 «Графики»
- Код: `wclock5/static/js/invest_chart_helpers.js`, `wclock5/app.py`,
  `wclock5/hft/static/js/invest_chart_helpers.js`, `wclock5/hft/app.py`
- Беклог: `wclock5/docs/02_project/backlogs/backlog_20260831.ldn.md` (CHRT-FIX),
  `wclock5/docs/02_project/backlogs/backlog_20261021.ldn.md` (GRD-09..12),
  `wclock5/docs/02_project/backlogs/backlog_20261022.ldn.md` (GRD-13)
- Сессия 03.11.2026 (GRD-14..22): `parsers/invest/fx_candles.py`,
  `parsers/invest/backfill_8w.py`, `parsers/invest/tracked_tickers_daemon.py`,
  `invest_repo.py`, `app.py`, `static/js/invest_chart.js`
- Фреймворк: `01.lab/02_project/PROC_graph_approaches.md`,
  `01.lab/00_rules/10_samples/CHART_invest.html` (+ `10_samples/chart_invest/`)

## Лист изменений

- **0.5** · 2026-11-03 — GRD-14..22: свечи USD/RUB через `GetCandles` в обе БД
  + бэкфилл 8 недель; раздельные ₽-оси от первого ненулевого значения; сетка X
  как объединение портфеля и тикеров (+`_midnightTimestamps`); `spanGaps:false`
  для портфельных линий; тултип `DD.MM.YYYY HH:MM`; период `-N week`; роут
  тикера со слэшем; нормализация кэш-ключа; XAU через Yahoo API без yfinance.
- **0.4** · 2026-10-22 — GRD-13 (полоса «Spread» TGLD@ на графике:
  `MorningGapPlugin` + `loadMorningGap`, цвета `jumpUp/jumpDown/jumpAvg`),
  правило 11; эпик закрыт (все GRD ✅).
- **0.3** · 2026-10-21 — GRD-09 (настройка цветов тикеров в редакторе
  параметров: `ChartTheme` + `tickerColor`/`themeColor`; группа «Цвета тикеров»
  последней во 2-м столбце), GRD-10 (метки периода USD/Brent), GRD-11 (метки
  скрытых серий не рисуются), GRD-12 (Brent `#556B2F`); правила 9–10; ссылки на
  `chart_config.js` и беклог 21.10.
- **0.2** · 2026-09-16 — GRD-06 (apiErrorPoints), GRD-07 (XAU метки периода +
  `s.fmt`), GRD-08 (линия 100% полупрозрачная белая + `borderDash [8,6]`).
- **0.1** · 2026-08-31 — создан: разбор инцидента (взрыв точек), правила
  бюджета точек/замка обновления, GRD-01..05, числа до/после.
