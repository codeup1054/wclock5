# Changelog wClock v5.0

## [5.0.2] - 2026-05-30 (Оптимизация v2 + багфиксы)

### Critical
- **`isUpdating` timeout**: Добавлен защитный таймаут 15с к флагу блокировки в `invest_chart.js` — если запрос к API завис, обновления не блокируются навсегда
- **Дублирующийся resize-обработчик**: Удалён второй `$(window).on('resize')` в `invest_chart.js` — график ресайзился дважды на каждое изменение окна
- **`Math.max` с пустым массивом**: Подстраховка от `-Infinity` при отсутствии данных в портфеле

### Performance
- **Серверная агрегация данных**: Все invest-эндпоинты (`/api/invest/history`, `/api/invest/ticker`, `/api/invest/tickers`) теперь группируют данные по time bucket'ам на сервере. Трафик уменьшен в ~70 раз:
  - `history`: 45 885 → 642 точки
  - `TGLD@`: 22 616 → 307 точек
- **Баннер без дублирующего fetch**: InvestBanner получает данные от InvestPlot после каждого обновления графика (через `InvestBanner.renderFromData()`). Убран отдельный cron-запрос.
- **Убран period-фильтр в API**: Т.к. данные теперь агрегируются сервером, ограничение по дате больше не нужно — возвращаются все доступные данные, сжатые до ~1 точки в час.

### Changed
- `invest_chart.js` — `isUpdating` timeout, удалён мёртвый код (`renderInvestBanner`, `updateInvestBannerData`), удалён дублирующий resize, исправлен `Math.max`
- `invest_banner.js` — добавлен `renderFromData(historyData, tgoldPrices)` для получения данных от графика
- `cron.js` — исправлен комментарий и console.log (реальный интервал 120с, а не 60)
- `app.py` — серверная агрегация для всех invest-эндпоинтов, убран period-фильтр
- `CHANGE_LOG.md` — обновлено

## [5.0.1] - 2026-05-30 (Оптимизация для планшетов)

### Critical (устранение причин закрытия браузера)
- **Утечка Canvas-памяти**: Добавлена `destroyChartSafe()` — обнуление буфера canvas перед destroy (освобождает GPU память). Лимит DPR = 1.5 (было devicePixelRatio * 2, что на планшетах создавало буферы 7680×4320+)
- **Дедупликация таймеров**: Убран отдельный `setInterval` из `invest_banner.js` — обновление баннера теперь работает через `cron.js` (единый оркестратор)
- **WakeLock с авто-освобождением**: WakeLock автоматически отпускается через 5 минут для экономии батареи

### Performance
- **DPR оптимизация**: WeatherChart и InvestChart — `devicePixelRatio` теперь ограничен 1.5, убран двойной множитель
- **Resize throttling**: Ресайз окон теперь через `requestAnimationFrame` + проверка изменения размера (не перерисовывает график если размер не изменился)
- **Удалён `invest_chart_data.js`**: Неиспользуемый файл на 199 263 строк (~8MB) удалён из HTML
- **SQL N+1 → 1**: `api_invest_tickers` — единый запрос вместо цикла с N запросами

### Changed
- `weather_chart.js` — рефакторинг: `getSafeDPR()`, `destroyChartSafe()`, убран `DPR_MULTIPLIER`
- `invest_chart.js` — рефакторинг: `getSafeDPR()`, zero canvas before destroy
- `cron.js` — добавлена регистрация `InvestBanner` как задачи
- `app.py` — `api_invest_tickers`: один SQL-запрос + группировка в Python

## [5.0] - 2026-03-16

### Added
- Temperature range slider label above dual-range sliders
- Panel resize handles (8 directions: nw, ne, sw, se, n, s, e, w)
- Invest banner HTML version (alternative to canvas)
- Week change display (7 days) in investment banner
- TGLD@ gold ticker display in banner
- Asset bars with percentage visualization

### Fixed
- Duplicate `$header` variable declaration in lib.js causing SyntaxError
- Port configuration (10405 instead of 8004)
- Temperature label updates dynamically with slider values

### Changed
- CSS redesign for seconds panel
- Larger moon phase display (21vh)
- Updated wind direction compass size (10vw)
- Resize handles visible in edit-mode with orange color
- Invest banner: removed debug console.logs, improved error handling

### Infrastructure
- Git repository initialized
- Docker port mapping: 10405:5000

---

## [4.x] - Previous versions
See project history for earlier changes.
