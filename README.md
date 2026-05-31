# WClock 5

Full-screen smart clock web app for wall-mounted displays. Shows time, weather, investment portfolio, battery monitoring, and more.

## Stack

| Component | Tech |
|-----------|------|
| Backend | Python 3.11, Flask |
| Frontend | jQuery, Chart.js, vanilla JS |
| Database | SQLite (3 files) |
| Container | Docker, Docker Compose |
| Proxy | Nginx + Certbot (SSL) |

## Setup

### Prerequisites

- Python 3.11+, pip
- Docker + Docker Compose (for production)

### Local dev

```bash
python -m venv venv
source venv/bin/activate    # or venv\Scripts\activate on Windows
pip install -r requirements.txt
python app.py
```

### Docker

```bash
PORT=10405 docker compose up -d --build
```

## Configuration

Copy `.env.example` to `.env` and set:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | no | 5001 | App port |
| `DOCKER_PREFIX` | no | wclock5 | Container prefix |
| `API_TOKEN` | yes (Tinkoff) | - | Tinkoff Invest API token |
| `ACCOUNT_ID` | yes (Tinkoff) | - | Tinkoff account ID |

## Deploy

```bash
# Full rebuild (copy + docker build + restart)
echo "yes" | bash sh/options/deploy/full_rebuild.sh

# Or via devops menu
bash sh/devops.sh        # interactive
bash sh/devops.sh remote # non-interactive deploy
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `/api/weather` | Current weather + forecast |
| `/api/charts_data` | Weather chart data |
| `/api/battery` | Battery log (POST/GET) |
| `/api/invest/history` | Portfolio history |
| `/api/invest/tickers` | Ticker prices |
| `/api/settings` | App settings |
| `/api/panel_config/<device_id>` | Panel layout config |

## Project structure

```
├── app.py                 # Flask app
├── docker-compose.yml
├── Dockerfile
├── parsers/               # Data parsers (weather, invest, tickers)
│   ├── mail.ru/
│   └── invest/
├── static/
│   ├── js/                # Frontend modules
│   │   ├── lib.js         # Shared utilities
│   │   ├── battery.js     # Battery API + chart
│   │   ├── weather_chart.js
│   │   ├── invest_chart.js / invest_chart_helpers.js
│   │   ├── chart_plugins.js
│   │   ├── panel_resize.js
│   │   ├── cron.js        # Orchestrator
│   │   └── index.js       # Main init
│   └── css/
├── templates/
└── sh/                    # Deploy scripts
```

## Features

- Digital clock with date, moon phase, daylight times
- Weather: current conditions, hourly forecast, charts (temp, pressure, humidity, wind)
- Investment portfolio graph with daily growth and extrema labels
- Battery level monitoring (per-device, chart history)
- Customizable panel layout (drag, resize, fullscreen, config per device)
- Edit mode for panel repositioning
- Docker-based parsing daemons (weather, invest, tickers)
