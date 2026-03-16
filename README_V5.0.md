# WClock 5.0 — Техническая документация

> **Версия документа:** 5.0-draft  
> **Дата:** 2026-03-16  
> **Статус:** Черновик для перехода на версию 5.0

---

## Содержание

1. [Обзор проекта](#1-обзор-проекта)
2. [Архитектура](#2-архитектура)
3. [Change Log](#3-change-log)
4. [Описание функций](#4-описание-функций)
5. [Технические детали](#5-технические-детали)
6. [Предложения по оптимизации](#6-предложения-по-оптимизации)
7. [Backlog для новых функций](#7-backlog-для-новых-функций)
8. [Рефакторинг для версии 5.0](#8-рефакторинг-для-версии-50)
9. [Миграция с текущей версии](#9-миграция-с-текущей-версии)

---

## 1. Обзор проекта

**WClock** — полноэкранное веб-приложение «умные часы» для отображения на настенном дисплее:

- Цифровые часы с датой и днём недели
- Текущая погода и прогноз (парсинг из mail.ru)
- Графики погоды (Chart.js)
- Инвестиционный портфель (Tinkoff Invest API)
- Мониторинг батареи устройств
- Фазы Луны, восход/заход солнца
- Давление, влажность, ветер

### Текущий стек

| Компонент | Технология |
|-----------|------------|
| Backend | Python 3.11, Flask |
| Frontend | HTML/CSS/JS (jQuery, Chart.js) |
| Database | SQLite (3 файла БД) |
| Containerization | Docker, Docker Compose |
| Web Server | Nginx (reverse proxy) |
| SSL | Certbot (Let's Encrypt) |
| Deployment | SSH + SCP |

---

## 2. Архитектура

### 2.1 Компонентная диаграмма

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                Nginx                                        │
│                    (Reverse Proxy + SSL termination)                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    │                                   │
              ┌─────▼─────┐                      ┌──────▼──────┐
              │  wclock4  │                      │   SSL       │
              │   -app    │                      │  Certs      │
              │  :5000    │                      │             │
              └─────┬─────┘                      └─────────────┘
                    │
        ┌───────────┼───────────┬───────────────┐
        │           │           │               │
   ┌────▼────┐ ┌────▼────┐ ┌────▼────┐   ┌──────▼──────┐
   │ weather │ │ invest  │ │tickers   │   │   Static    │
   │ parser  │ │ parser  │ │ parser   │   │   Files     │
   └─────────┘ └─────────┘ └─────────┘   └─────────────┘
        │           │           │
        └───────────┴───────────┘
                    │
         ┌──────────┴──────────┐
         │                     │
   ┌─────▼─────┐        ┌──────▼──────┐
   │ odintsovo │        │  invest_    │
   │ _weather  │        │ portfolio.db│
   │ .db       │        │             │
   └───────────┘        └─────────────┘
```

### 2.2 Docker-сервисы

| Сервис | Контейнер | Описание |
|--------|-----------|----------|
| `wclock` | `wclock4-app` | Flask-приложение |
| `weather-parser` | `wclock4-parser` | Парсер погоды mail.ru |
| `invest-parser` | `wclock4-inv` | Парсер портфеля Tinkoff |
| `tickers-parser` | `wclock4-tickers` | Парсер котировок |

### 2.3 Базы данных

```
parsers/
├── mail.ru/
│   └── odintsovo_weather.db    # Погода (current, hourly_forecast, settings, battery_logs)
└── invest/
    ├── invest_portfolio.db     # Портфель (portfolio_positions)
    └── tracked_tickers.db      # Котировки (last_prices)
```

### 2.4 API эндпоинты

```
/api/weather                      # Текущая погода и прогноз
/api/charts_data                  # Данные для графиков погоды
/api/battery                      # Логирование/получение данных батареи
/api/settings                     # Настройки приложения
/api/invest/history               # История портфеля
/api/invest/ticker/<ticker>       # Данные по тикеру
/api/invest/tickers              # Все тикеры
/api/set_mode                     # Установка режима (invest/basic)
/api/get_mode                     # Получение текущего режима
```

---

## 3. Change Log

### Версия 4.x → 5.0 (планируемое)

> **Статус:** В разработке

#### Добавлено
- [ ] Мобильная адаптация панелей (MOBILE_PANEL_CONFIG)
- [ ] Переключение конфигурации при resize >768px
- [ ] Улучшенная обработка панелей на таблетах
- [ ] Docker Compose с env_file для всех сервисов

#### Изменено
- [ ] Переименование ID: `fullscreen` → `browser_fullscreen`, `reload` → `browser_reload`
- [ ] Удаление кнопки fullscreen из chart_control_panel
- [ ] Оптимизация z-index для панелей

#### Исправлено
- [ ] Панели не сжимаются до 150px на таблетах
- [ ] Invest chart загружается только при show_invest=true

---

### Версия 4.0 (текущая стабильная)

#### Добавлено
- Docker Compose с 4 сервисами (app, weather-parser, invest-parser, tickers-parser)
- Парсер тикеров TGLD@, GDH6 (Tracked Tickers)
- Banner с графиком инвестиций
- SSL-сертификаты через Certbot
- Nginx reverse proxy
- Деплой-скрипты (deploy.sh, dev_deploy.sh)
- Admin-меню для диагностики

#### Инвестиции
- API для портфеля (история позиций)
- API для тикеров (TGLD@, GDH6)
- Графики Chart.js с crosshair
- Banner-версия графика

#### UI/UX
- Panel resize с drag & drop
- Cookie persistence для позиций панелей
- Edit mode для перемещения панелей
- Fullscreen для панелей с графиками
- Collapse для control panel
- Батарея: индикатор + график

---

### Версия 3.x

#### Добавлено
- Battery API и логирование
- Battery chart panel
- Графики давления/влажности
- Настройки в БД (PAGE_RELOAD_MIN, etc.)

---

### Версия 2.x

#### Добавлено
- SQLite база данных
- Парсер mail.ru погоды
- Chart.js графики
- Фазы Луны

---

### Версия 1.x

#### Добавлено
- Flask-приложение
- Часы, дата, погода
- Базовая верстка

---

## 4. Описание функций

### 4.1 Панели интерфейса

| Панель | ID | Описание |
|--------|-----|----------|
| Clock | `clock_panel` | Цифровые часы (ЧЧ:ММ:СС) |
| Date | `date_panel` | Дата и день недели |
| Weather | `weather_panel` | График погоды (Chart.js) |
| Invest | `invest_panel` | График портфеля |
| Invest Banner | `invest_panel_banner` | Компактный график |
| Battery Indicator | `battery_indicator_panel` | Иконка батареи |
| Battery Chart | `battery_chart_panel` | График заряда |
| Pressure/Humidity | `press_humidity_temp_panel` | Давление, влажность, температура |
| Wind/Cond/Precip | `wind_cond_precip_panel` | Ветер, условия, осадки |
| Sun | `sun_panel` | Восход/заход солнца |
| Moon | `moon_panel` | Фаза Луны |
| Control | `chart_control_panel` | Управление графиками |

### 4.2 Режимы отображения

- **basic** — только погода, часы, дата (без инвестиций)
- **invest** — полный режим с графиками портфеля

Переключение: `?KEY=6HKJ809-YUI67-HKJJL-5677-HJKK` или cookie `wclock_mode=invest`

### 4.3 Парсеры

#### Weather Parser (`mail_ru_weather_24hours.py`)
- Парсит погоду с mail.ru
- Интервал: 30 минут (настраивается)
- Сохраняет: current + hourly_forecast

#### Invest Parser (`tinkoff_invest_daemon.py`)
- Tinkoff Invest API
- Обновляет позиции портфеля
- Интервал: 15 минут

#### Tickers Parser (`tracked_tickers_daemon.py`)
- Отслеживает тикеры: TGLD@, GDH6
- Сохраняет историю цен

### 4.4 Docker-сервисы

| Переменная | Описание | Пример |
|-----------|----------|--------|
| PORT | Порт приложения | 10104 |
| DOCKER_PREFIX | Префикс контейнеров | wclock4 |
| SSH_USER | Пользователь SSH | root |
| SSH_HOST | Хост | example.com |
| DOMAIN | Домен | wclock.example.com |

---

## 5. Технические детали

### 5.1 Зависимости (requirements.txt)

```
Flask>=2.3.0
playwright>=1.40.0
requests==2.31.0
beautifulsoup4==4.12.2
Pillow==10.3.0
apscheduler>=3.9,<4
python-dotenv>=1.0.0
```

### 5.2 Структура БД

#### odintsovo_weather.db

```sql
-- Текущая погода
CREATE TABLE current (
    collected_at TEXT,
    datetime TEXT,
    temperature INTEGER,
    feels_like INTEGER,
    description TEXT,
    pressure INTEGER,
    wind_direction TEXT,
    wind_speed INTEGER,
    humidity INTEGER,
    uv_index INTEGER,
    wind_dir_full TEXT,
    soil_temp REAL,
    pollen_level TEXT,
    geomagnetic TEXT
);

-- Почасовой прогноз
CREATE TABLE hourly_forecast (
    collected_at TEXT,
    time TEXT,
    temperature INTEGER,
    feels_like INTEGER,
    description TEXT,
    pressure INTEGER,
    wind_direction TEXT,
    wind_speed INTEGER,
    humidity INTEGER,
    precip_prob INTEGER,
    icon_url_light TEXT,
    icon_url_day TEXT
);

-- Настройки
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Логи батареи
CREATE TABLE battery_logs (
    id INTEGER PRIMARY KEY,
    datetime TEXT,
    device_id TEXT,
    battery_level INTEGER
);
```

#### invest_portfolio.db

```sql
-- Позиции портфеля
CREATE TABLE portfolio_positions (
    id INTEGER PRIMARY KEY,
    timestamp TEXT,
    instrument_type TEXT,
    name TEXT,
    ticker TEXT,
    quantity REAL,
    price REAL,
    value REAL
);
```

#### tracked_tickers.db

```sql
-- Исторические цены
CREATE TABLE last_prices (
    id INTEGER PRIMARY KEY,
    timestamp TEXT,
    figi TEXT,
    ticker TEXT,
    class_code TEXT,
    price REAL
);
```

### 5.3 Фронтенд-скрипты

| Файл | Назначение |
|------|------------|
| `index.js` | Главный модуль, инициализация |
| `panel_resize.js` | Drag/resize панелей, mobile config |
| `weather_chart.js` | График погоды |
| `invest_chart.js` | График портфеля |
| `invest_chart_banner.js` | Banner график |
| `invest_chart_data.js` | Данные для графиков |
| `chart_plugins.js` | Плагины Chart.js |
| `battery.js` | Батарея API и график |
| `cron.js` | Обновление данных |
| `control_panel.js` | Панель управления |
| `cookie.js` | Работа с cookies |
| `lib.js` | Утилиты |

---

## 6. Предложения по оптимизации

### 6.1 Производительность

| Проблема | Решение | Приоритет |
|----------|---------|-----------|
| 3 файла SQLite | Объединить в 1 БД | Средний |
| Много chart.js инстансов | Использовать один canvas | Высокий |
| jQuery зависимость | Переписать на vanilla JS | Низкий |
| Парсинг каждые 30 мин | Кэшировать, обновлять по требованию | Средний |

### 6.2 Безопасность

| Проблема | Решение | Приоритет |
|----------|---------|-----------|
| API без аутентификации | Добавить API key | Высокий |
| hardcoded VALID_KEY | Перенести в .env | Высокий |
| Tinkoff token в .env | Использовать secrets | Высокий |

### 6.3 Инфраструктура

| Проблема | Решение | Приоритет |
|----------|---------|-----------|
| 4 отдельных контейнера | Объединить в 1 (multi-stage) | Средний |
| Ручной деплой | CI/CD (GitHub Actions) | Низкий |
| Нет мониторинга | Добавить Prometheus/Grafana | Низкий |

### 6.4 UI/UX

| Проблема | Решение | Приоритет |
|----------|---------|-----------|
| Нет темной темы | CSS variables для theme | Средний |
| Нет PWA | manifest.json, service worker | Низкий |
| Медленная загрузка | Lazy loading, code splitting | Средний |

---

## 7. Backlog для новых функций

### 7.1 Высокий приоритет (MVP 5.0)

- [ ] **Объединение БД** — единая SQLite с таблицами: weather, battery, invest, settings
- [ ] **API Authentication** — API key для защиты эндпоинтов
- [ ] **Mobile-first** — полная адаптация под мобильные устройства
- [ ] **Темная тема** — CSS variables, переключение по времени/кнопке
- [ ] **PWA support** — manifest, offline-first

### 7.2 Средний приоритет

- [ ] **WebSocket** — real-time обновления вместо polling
- [ ] **Кэширование** — Redis для кэша погоды
- [ ] **Health check** — /health эндпоинт для мониторинга
- [ ] **Metrics** — базовые метрики (requests, response time)

### 7.3 Низкий приоритет

- [ ] **Dashboard** — админ-панель для настроек
- [ ] **CI/CD** — автоматический деплой
- [ ] **Мониторинг** — Prometheus + Grafana
- [ ] **Alerts** — уведомления при проблемах (TG bot)
- [ ] **Plugins** — система плагинов для новых источников

### 7.4 Future (6.0+)

- [ ] **ML** — прогноз температуры
- [ ] **Widgets** — пользовательские виджеты
- [ ] **Multi-location** — несколько локаций
- [ ] **Users** — авторизация, личные настройки

---

## 8. Рефакторинг для версии 5.0

### 8.1 Структура проекта

```
wclock5/
├── app.py                      # Flask (разделить на blueprint'и)
├── config.py                   # Конфигурация (сейчас в .env)
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
├── db/
│   ├── schema.sql              # Схема БД
│   └── migrations/             # Alembic миграции
├── src/
│   ├── api/                    # API routes
│   │   ├── weather.py
│   │   ├── battery.py
│   │   ├── invest.py
│   │   └── settings.py
│   ├── models/                 # Модели данных
│   ├── services/              # Бизнес-логика
│   │   ├── weather_parser.py
│   │   ├── invest_parser.py
│   │   └── ticker_parser.py
│   └── utils/                  # Утилиты
├── parsers/                    # Парсеры (как есть)
│   ├── mail.ru/
│   └── invest/
├── static/
│   ├── js/
│   │   ├── components/         # Web Components
│   │   └── utils/
│   └── css/
│       ├── variables.css      # CSS variables
│       ├── theme-light.css
│       └── theme-dark.css
├── templates/
│   └── index.html
└── tests/
```

### 8.2 Разделение ответственности

#### app.py → Blueprint'ы

```python
# src/api/weather.py
weather_bp = Blueprint('weather', __name__, url_prefix='/api/weather')

@weather_bp.route('')
def get_weather():
    ...

# src/api/battery.py
battery_bp = Blueprint('battery', __name__, url_prefix='/api/battery')
```

#### Парсеры → Отдельные классы

```python
# src/services/weather_parser.py
class WeatherParser:
    def __init__(self, db_path: str):
        ...
    
    def fetch(self) -> dict:
        ...
    
    def save(self, data: dict):
        ...
```

### 8.3 Конфигурация

```python
# config.py
from dataclasses import dataclass
from pathlib import Path
import os

@dataclass
class Config:
    DEBUG: bool = False
    DB_PATH: str = "wclock.db"
    API_KEY: str = ""
    TINKOFF_TOKEN: str = ""
    PARSERS_INTERVAL: int = 1800  # 30 min
    
    @classmethod
    def from_env(cls):
        return cls(
            DEBUG=os.getenv("DEBUG", "False") == "True",
            DB_PATH=os.getenv("DB_PATH", "wclock.db"),
            API_KEY=os.getenv("API_KEY", ""),
            TINKOFF_TOKEN=os.getenv("TINKOFF_TOKEN", ""),
        )
```

### 8.4 Единая база данных

```sql
-- schema.sql
CREATE TABLE weather_current (
    id INTEGER PRIMARY KEY,
    collected_at TEXT NOT NULL,
    temperature INTEGER,
    feels_like INTEGER,
    description TEXT,
    pressure INTEGER,
    humidity INTEGER,
    wind_speed INTEGER,
    wind_direction TEXT,
    wind_dir_full TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE weather_forecast (
    id INTEGER PRIMARY KEY,
    collected_at TEXT NOT NULL,
    forecast_time TEXT NOT NULL,
    temperature INTEGER,
    feels_like INTEGER,
    description TEXT,
    pressure INTEGER,
    humidity INTEGER,
    precip_prob INTEGER,
    wind_speed INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE battery_logs (
    id INTEGER PRIMARY KEY,
    device_id TEXT NOT NULL,
    battery_level INTEGER NOT NULL,
    recorded_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE portfolio_positions (
    id INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    instrument_type TEXT,
    name TEXT,
    ticker TEXT,
    quantity REAL,
    price REAL,
    value REAL
);

CREATE TABLE ticker_prices (
    id INTEGER PRIMARY KEY,
    figi TEXT NOT NULL,
    ticker TEXT,
    price REAL,
    recorded_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_weather_forecast_time ON weather_forecast(forecast_time);
CREATE INDEX idx_battery_device_time ON battery_logs(device_id, recorded_at);
CREATE INDEX idx_portfolio_time ON portfolio_positions(timestamp);
CREATE INDEX idx_ticker_time ON ticker_prices(figi, recorded_at);
```

### 8.5 Frontend рефакторинг

#### CSS Variables (темы)

```css
:root {
    /* Colors - Light */
    --bg-primary: #ffffff;
    --bg-secondary: #f5f5f5;
    --text-primary: #333333;
    --text-secondary: #666666;
    --accent: #2196F3;
    --panel-bg: rgba(255, 255, 255, 0.95);
    --panel-border: #e0e0e0;
    
    /* Typography */
    --font-family: 'Roboto', sans-serif;
    --font-size-base: 16px;
    
    /* Spacing */
    --spacing-xs: 4px;
    --spacing-sm: 8px;
    --spacing-md: 16px;
    --spacing-lg: 24px;
}

[data-theme="dark"] {
    --bg-primary: #121212;
    --bg-secondary: #1e1e1e;
    --text-primary: #ffffff;
    --text-secondary: #b0b0b0;
    --accent: #64b5f6;
    --panel-bg: rgba(30, 30, 30, 0.95);
    --panel-border: #333333;
}
```

#### Web Components (опционально)

```javascript
// static/js/components/wclock-panel.js
class WClockPanel extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
    }
    
    connectedCallback() {
        this.render();
    }
    
    render() {
        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    display: block;
                    position: absolute;
                    ...
                }
            </style>
            <slot></slot>
        `;
    }
}

customElements.define('wclock-panel', WClockPanel);
```

### 8.6 API Key аутентификация

```python
# src/utils/auth.py
from functools import wraps
from flask import request, jsonify
import os

def require_api_key(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        api_key = request.headers.get('X-API-Key')
        valid_key = os.getenv('API_KEY', '')
        
        if valid_key and api_key != valid_key:
            return jsonify({'error': 'Unauthorized'}), 401
        return f(*args, **kwargs)
    return decorated

# Использование
@weather_bp.route('/current')
@require_api_key
def get_current_weather():
    ...
```

---

## 9. Миграция с текущей версии

### 9.1 Совместимость

| Компонент | 4.x → 5.0 | notes |
|-----------|-----------|-------|
| API endpoints | ✅ | Без изменений |
| Frontend | ⚠️ | CSS variables, темы |
| DB schema | 🔄 | Новая схема |
| Docker | ✅ | Обратная совместимость |
| Config | ⚠️ | Дополнительные переменные |

### 9.2 План миграции

1. **Бэкап** — сделать копию БД и static files
2. **Обновить зависимости** — `pip install -r requirements.txt`
3. **Запустить миграцию БД** — если объединяем в одну
4. **Обновить фронтенд** — добавить CSS variables
5. **Тестирование** — локально проверить все эндпоинты
6. **Деплой** — `./deploy.sh`
7. **Верификация** — проверить все панели

### 9.3 Роллбэк

- Сохранить старую версию в отдельной директории
- Docker tag для отката: `docker tag wclock5-app wclock4-rollback`
- Оставить старую конфигурацию в deploy.conf

---

## Приложения

### A. Команды администрирования

```bash
# Локальный запуск
python app.py

# Docker
docker-compose up -d
docker-compose logs -f

# Деплой
./sh/deploy.sh 1          # Деплой
./sh/deploy.sh 2          # Пересобрать
./sh/dev_deploy.sh        # Меню админа
```

### B. Переменные окружения

```
# Обязательные
TINKOFF_TOKEN=xxx        # Token Tinkoff Invest
MAIL_RU_LOGIN=xxx        # Логин mail.ru
MAIL_RU_PASSWORD=xxx     # Пароль mail.ru

# Опциональные
PORT=10104               # Порт
DOCKER_PREFIX=wclock4    # Префикс контейнеров
DEBUG=False              # Режим отладки
API_KEY=xxx              # API key для защиты
```

### C. Структура директорий сервера

```
/opt/wclock/
├── docker-compose.yml
├── .env
├── app/
│   ├── app.py
│   ├── db_init.py
│   ├── templates/
│   ├── static/
│   └── parsers/
├── nginx/
│   ├── wclock.conf
│   └── ssl/
└── logs/
    ├── nginx/
    └── docker/
```

---

**Автор:** WClock Project  
**Лицензия:** MIT  
**Версия:** 5.0-draft
