# 🕐 WClock5 DevOps Guide

> Clock dashboard: погода, инвестиции, батарея, профили панелей.

## Лист изменений

- **2.0** · 2026-11-05 — добавлен локальный запуск **без Docker**
  (`./sh/devops.sh local | upall | stop | lstatus | llogs | deps`):
  venv + `python app.py`, PID/логи в `logs/local/`, порт `LOCAL_PORT=5001`
  (Docker-порт 10405 не затрагивается). Скрипт стал кроссплатформенным:
  на Windows используются `netstat` / `tasklist` / `taskkill` и PID-файлы,
  потому что `lsof` / `pgrep` / `pkill` в Git Bash отсутствуют.
  Актуализированы: путь `wclock5`, порт `10405`, контейнеры `wclock5-*`,
  список сервисов `docker-compose.yml`, перезапуск всех демонов.
  Убраны устаревшие `wclock3/wclock4`, FastAPI, порт 10104.
- **1.0** · 2026-10 — первая версия гайда (wclock4, только Docker).

## Содержание

- [Можно ли запустить без Docker?](#можно-ли-запустить-без-docker)
- [Quick Start](#quick-start)
- [Локальный запуск без Docker](#локальный-запуск-без-docker)
- [Команды devops.sh](#команды-devopssh)
- [Architecture](#architecture)
- [Scripts](#scripts)
- [Configuration](#configuration)
- [Docker Services](#docker-services)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [Maintenance](#maintenance)
- [Files Structure](#files-structure)
- [SSL Certificate](#ssl-certificate)
- [Appendix: Scripts Reference](#appendix-scripts-reference)
- [PUML Diagrams](#puml-diagrams)

---

## Можно ли запустить без Docker?

Да. Приложение — обычный Flask-проект, Docker нужен только для изоляции
и автозапуска демонов. Без Docker работает:

| Что | Без Docker | Комментарий |
|-----|-----------|-------------|
| Web UI + API (`app.py`) | ✅ | `python app.py`, порт `LOCAL_PORT` (5001) |
| Чтение БД (`parsers/*/*.db`) | ✅ | те же файлы, что монтируются в контейнеры |
| Профили, настройки, кэш | ✅ | `profiles/`, `cache/`, `settings` в БД |
| Демоны (погода, тикеры, инвестиции, Finam, FX) | ⚠️ | только если с хоста есть сеть/DNS |
| Playwright/Chromium | ➖ | приложению не нужен |
| Автозапуск после перезагрузки | ❌ | Docker делает `restart: unless-stopped` |

Ограничения локального режима:

1. **Сеть.** В текущем окружении DNS на хосте не работает, а из контейнеров
   сеть доступна. Поэтому локально имеет смысл запускать только веб,
   а демоны — в Docker. Скрипт предупреждает об этом перед стартом демонов.
2. **Файлы БД общие.** Локальные демоны и контейнеры пишут в одни и те же
   `parsers/invest/*.db`. Не запускайте одно и то же одновременно.
3. **Секреты.** Демоны читают `.env` (Finam/T-Invest токены) сами; вебу
   для чтения БД `.env` не нужен.
4. **Зависимости.** Вебу достаточно Flask. Демонам нужны `requests`,
   `apscheduler`, `beautifulsoup4`, `python-dotenv`, `yfinance`
   (ставятся командой `./sh/devops.sh deps`).

---

## Quick Start

### Docker (как на проде)

```bash
cd E:/_dev/10.gpx/04.gpx_clock_beget/wclock5

./sh/run_docker.sh start          # docker compose up -d
# или
docker compose up -d --build
```

Приложение: `http://127.0.0.1:10405/`
Вход в инвестиции: `http://127.0.0.1:10405/?KEY=6HKJ809-YUI67-HKJJL-5677-HJKK`

### Без Docker (локально)

```bash
cd E:/_dev/10.gpx/04.gpx_clock_beget/wclock5

./sh/devops.sh local              # веб на http://127.0.0.1:5001/
./sh/devops.sh lstatus            # PID, HTTP, свежесть данных
./sh/devops.sh stop               # остановить
```

---

## Локальный запуск без Docker

### Что делает `local`

1. Проверяет `venv` (создаёт при отсутствии: `python -m venv venv`).
2. Проверяет Flask в venv; при отсутствии — `pip install -r requirements.txt`.
3. Освобождает `LOCAL_PORT` (по умолчанию 5001), если он занят.
4. Запускает `python -u app.py` с `PORT=$LOCAL_PORT`.
5. Пишет PID в `logs/local/web.pid`, лог — в `logs/local/web.log`.
6. Ждёт ответ и печатает URL.

`upall` делает то же и дополнительно поднимает демонов из `LOCAL_DAEMONS`
(по умолчанию: `weather tickers tinkoff finam funit funit2 tdiv trnd fx`).

### Демоны локально

| Имя | Скрипт | Env |
|-----|--------|-----|
| `weather` | `parsers/mail.ru/mail_ru_weather_24hours.py` | — |
| `tickers` | `parsers/invest/tracked_tickers_daemon.py` | — |
| `tinkoff` | `parsers/invest/tinkoff_invest_daemon.py` | — |
| `finam` | `parsers/invest/finam_invest_daemon.py` | `INVEST_SOURCE=finam` |
| `funit` | `parsers/invest/finam_invest_daemon.py` | `INVEST_SOURCE=funit` |
| `funit2` | `parsers/invest/finam_invest_daemon.py` | `INVEST_SOURCE=funit2` |
| `tdiv` | `parsers/invest/account_invest_daemon.py` | `INVEST_SOURCE=tdiv` |
| `trnd` | `parsers/invest/account_invest_daemon.py` | `INVEST_SOURCE=trnd` |
| `fx` | `parsers/invest/fx_sources.py --days 3` (цикл 15 мин) | — |

Поднять только часть:

```bash
LOCAL_DAEMONS="tickers tinkoff" ./sh/devops.sh upall
```

Логи и PID: `logs/local/<имя>.log`, `logs/local/<имя>.pid`
(каталог в `.gitignore`).

### Переменные окружения локального режима

| Переменная | По умолчанию | Назначение |
|-----------|--------------|------------|
| `LOCAL_PORT` | `5001` | порт локального веба (Docker — 10405) |
| `LOCAL_DAEMONS` | `weather tickers tinkoff finam funit funit2 tdiv trnd fx` | список демонов для `upall` |
| `PYTHON` | `python` / `python3` | интерпретатор для создания venv |

### Пример сессии

```bash
./sh/devops.sh local
#  ✓ venv: .../venv/Scripts/python.exe
#  ✓ WEB: http://127.0.0.1:5001/  (PID=21568)

./sh/devops.sh lstatus
#  ✓ web: PID=21568  http://127.0.0.1:5001/ → 200
#  данные (БД):
#    invest   записей=6  последняя=04.11 17:10
#    tickers  записей=260081  последняя=04.11 17:10
#    weather  записей=134  последняя=2026-11-04T17:03:39+03:00

./sh/devops.sh llogs web     # хвост лога
./sh/devops.sh stop
#  ✓ остановлен web (PID=21568)
```

### Windows: почему PID-файлы

В Git Bash нет `lsof` / `pgrep` / `pkill`. `$!` даёт MSYS-PID, а
`taskkill`/`tasklist` работают с Windows-PID. Скрипт:

- запускает процесс через `( cd ... && exec ... ) &`;
- переводит MSYS-PID → WINPID через `ps -W`;
- хранит WINPID в PID-файле;
- останавливает дерево процессов: `taskkill //F //T //PID`;
- порт освобождает через `netstat -ano`.

На Linux/macOS используются `kill`, `lsof` (или `ss`) — тот же код.

---

## Команды devops.sh

```bash
./sh/devops.sh              # интерактивное меню
./sh/devops.sh <команда>    # прямой запуск
```

### Локально (без Docker)

| Команда | Меню | Действие |
|---------|------|----------|
| `local` / `1` | 1 | веб на `LOCAL_PORT` |
| `upall` / `9` | 9 | веб + демоны (`LOCAL_DAEMONS`) |
| `stop` / `10` | 10 | остановить веб и демонов, освободить порт |
| `restart` / `5` | 5 | перезапустить локальный веб |
| `lstatus` / `11` | 11 | PID, HTTP, БД (свежесть данных) |
| `llogs <имя>` / `12` | 12 | `tail -f` лога `logs/local/<имя>.log` |
| `deps` / `13` | 13 | venv + полный `pip install -r requirements.txt` |

### Удалённо (прод)

| Команда | Меню | Действие |
|---------|------|----------|
| `remote` / `2` | 2 | сборка и деплой на VPS (`docker compose up -d --build`) |
| `static` / `3` | 3 | быстрый деплой `templates/` + `static/` и рестарт web |
| `parsers` / `4` | 4 | рестарт всех демонов на сервере |
| `diagnostic` / `6` | 6 | диагностика: процессы, HTTP, контейнеры, БД |
| `diag-reload` / `7` | 7 | диагностика + перезапуск контейнеров |
| `nginx-cache` / `8` | 8 | очистка кэша Nginx |
| `status` / `s` | s | локальный веб, Docker-порт и прод-домен |

`help` — краткий список команд.

---

## Architecture

```
┌────────────────────────── LOCAL MACHINE ──────────────────────────┐
│                                                                    │
│  Docker:                              Без Docker:                  │
│  docker compose up -d                 ./sh/devops.sh local         │
│        │                                   │                       │
│        ▼                                   ▼                       │
│  wclock5-app :10405 → :5000           venv → python app.py :5001   │
│  wclock5-parser (погода)              демоны (опционально)         │
│  wclock5-inv / -finam-inv / ...       logs/local/*.log             │
│  wclock5-tickers / -fx-sources                                     │
│        │                                                           │
│        └──────────────┬────────────────────────────────────────────┘
│                       ▼
│        parsers/invest/*.db, parsers/mail.ru/*.db
│        profiles/, cache/, templates/, static/
└────────────────────────────────────────────────────────────────────┘
                        │ SSH (deploy)
                        ▼
┌────────────────────────── REMOTE VPS ──────────────────────────────┐
│  Nginx :80/:443  →  wclock5-app :10405                             │
│  Docker Compose: app + 9 демонов (см. Docker Services)             │
│  /var/www/wclock5.startupassist.ru                                 │
└────────────────────────────────────────────────────────────────────┘
```

---

## Scripts

| Script | Description |
|--------|-------------|
| `sh/devops.sh` | Единая точка входа: локальный запуск без Docker, деплой, диагностика |
| `sh/run_docker.sh` | `start / stop / restart / status / logs / build` для Docker |
| `sh/run_local.sh` | Простой локальный запуск (веб + погода + T-Invest, без PID-файлов) |
| `sh/run_server.sh` | Диагностика сервера напрямую или по SSH |
| `sh/dev_deploy.sh` | Администрирование сервера: логи, ресурсы, SSL, деплой |
| `sh/dev_undeploy.sh` | Полная очистка сервера (контейнеры, SSL, файлы) |
| `sh/deploy_js.sh` | Быстрый деплой JS с MD5-проверкой |
| `sh/dev_service.sh` | Systemd-сервис (альтернатива Docker) |
| `sh/deploy.conf` | Конфигурация сервера и портов |

---

## Configuration

`sh/deploy.conf`:

```bash
SSH_HOST=217.114.8.5
SSH_USER=root
DOMAIN=wclock5.startupassist.ru
REMOTE_PATH=/var/www/wclock5.startupassist.ru
NGINX_CONFIG_PATH=/etc/nginx/sites-available
SSL_EMAIL=admin@startupassist.ru
PORT=10405                # внешний порт Docker-контейнера
DOCKER_PREFIX=wclock5
```

Локальный режим берёт **свой** порт: `LOCAL_PORT` (по умолчанию 5001),
поэтому `devops.sh local` не конфликтует с запущенным Docker.

### Port Format

```
XYAZZ  →  XY = project number (00-99)
         A  = subproject (0-9)
         ZZ = version (00-99)

Example: 10405 = project 10, subproject 4, version 05
```

---

## Docker Services

| Сервис compose | Контейнер | Команда |
|----------------|-----------|---------|
| `wclock` | `wclock5-app` | `python app.py` (порт 5000 → 10405) |
| `weather-parser` | `wclock5-parser` | `mail_ru_weather_24hours.py` |
| `invest-parser` | `wclock5-inv` | `tinkoff_invest_daemon.py` |
| `finam-invest-parser` | `wclock5-finam-inv` | `finam_invest_daemon.py` |
| `funit-invest-parser` | `wclock5-funit-inv` | `finam_invest_daemon.py` (`INVEST_SOURCE=funit`) |
| `funit2-invest-parser` | `wclock5-funit2-inv` | `finam_invest_daemon.py` (`INVEST_SOURCE=funit2`) |
| `tdiv-invest-parser` | `wclock5-tdiv-inv` | `account_invest_daemon.py` (`INVEST_SOURCE=tdiv`) |
| `trnd-invest-parser` | `wclock5-trnd-inv` | `account_invest_daemon.py` (`INVEST_SOURCE=trnd`) |
| `tickers-parser` | `wclock5-tickers` | `tracked_tickers_daemon.py` |
| `fx-sources-parser` | `wclock5-fx-sources` | `fx_sources.py --days 3` каждые 15 мин |

Все сервисы монтируют `parsers/`, `invest_portfolio.db`, `profiles/`,
`cache/`, `logs/` — правки на хосте видны контейнерам без пересборки.

### Manual Commands

```bash
# Локально (Docker Desktop должен быть запущен)
docker compose up -d
docker compose down
docker compose logs -f wclock
docker compose restart wclock

# На сервере
cd /var/www/wclock5.startupassist.ru
docker compose ps
docker compose up -d --build
```

---

## Deployment

```
deploy.conf → scp → docker compose down → up -d --build → image prune
```

| Что | Команда |
|-----|---------|
| Полный деплой | `./sh/devops.sh remote` |
| Только статика | `./sh/devops.sh static` (`templates/`, `static/`) |
| JS-паттерны | `bash sh/deploy_js.sh` (проверка `node --check` + MD5) |
| Рестарт демонов | `./sh/devops.sh parsers` |

Прод: `https://wclock5.startupassist.ru/`

---

## Troubleshooting

### Локальный режим

| Проблема | Решение |
|----------|---------|
| `venv не найден` | `./sh/devops.sh deps` |
| Порт занят | `./sh/devops.sh stop` или `LOCAL_PORT=5002 ./sh/devops.sh local` |
| `web: PID есть, HTTP 000` | `./sh/devops.sh llogs web` |
| Демон упал сразу | `./sh/devops.sh llogs <имя>`; чаще всего нет сети/токена |
| «Нет сети/DNS с хоста» | веб работает; демоны оставьте в Docker |
| Процесс не убивается | `taskkill //F //T //PID <pid>` (Windows), `kill -9` (Unix) |

### Docker / прод

```bash
docker ps
docker logs wclock5-app --tail 50
docker compose ps
curl -I https://wclock5.startupassist.ru/
ss -tlnp | grep 10405
```

| Проблема | Решение |
|----------|---------|
| `docker: cannot connect` | запустить Docker Desktop (`CustomWslDistroDir=E:\Docker\wsl`) |
| Порт 10405 занят | `netstat -ano \| findstr :10405` → освободить / сменить `PORT` |
| 502 Bad Gateway | `docker logs wclock5-app`; проверить `docker ps` |
| Контейнер в restart loop | `docker logs <container> --tail 100` |
| SSL failed | проверить DNS → `certbot certonly --nginx -d wclock5.startupassist.ru` |
| Нет данных в таблице | `./sh/devops.sh lstatus`; проверить демона `wclock5-inv` / Finam |

---

## Maintenance

### Backup

```bash
# БД проекта
scp root@217.114.8.5:/var/www/wclock5.startupassist.ru/parsers/invest/invest_portfolio.db .
scp root@217.114.8.5:/var/www/wclock5.startupassist.ru/parsers/mail.ru/odintsovo_weather.db .

# Или архивом на сервере
ssh root@217.114.8.5 "tar -czf /root/wclock5-db-$(date +%F).tar.gz \
  /var/www/wclock5.startupassist.ru/parsers/*/*.db"
```

### Update

```bash
./sh/devops.sh static    # css/js/html
./sh/devops.sh parsers   # после правок демонов
./sh/devops.sh remote    # полная пересборка
```

### Clean Server

```bash
./sh/dev_undeploy.sh     # ВНИМАНИЕ: удаляет контейнеры, SSL, файлы
```

---

## Files Structure

```
wclock5/
├── sh/
│   ├── devops.sh             # единая точка входа (local + remote)
│   ├── run_docker.sh         # управление Docker
│   ├── run_local.sh          # простой локальный запуск
│   ├── run_server.sh         # диагностика сервера
│   ├── dev_deploy.sh         # администрирование VPS
│   ├── dev_undeploy.sh       # очистка сервера
│   ├── deploy.conf           # конфигурация
│   └── deploy_ignore.txt     # исключения деплоя
├── static/                   # css/js
├── templates/                # index.html
├── parsers/
│   ├── mail.ru/              # погода (+ odintsovo_weather.db)
│   └── invest/               # демоны инвестиций (+ *.db)
├── profiles/                 # раскладки панелей
├── cache/                    # кэш API
├── logs/local/               # PID и логи локального режима (gitignore)
├── app.py                    # Flask
├── invest_repo.py            # слой данных инвестиций
├── panel_mediator.py         # медиатор панелей
├── docker-compose.yml
├── Dockerfile
├── requirements.txt
└── .env                      # секреты (gitignore)
```

---

## SSL Certificate

- Выпускается Certbot при первом деплое
- Срок 90 дней, автопродление включено
- Проверка: `certbot renew --dry-run`

---

## Appendix: Scripts Reference

### devops.sh

**Location:** `sh/devops.sh`

```bash
./sh/devops.sh                  # меню
./sh/devops.sh local            # веб без Docker
./sh/devops.sh upall            # веб + демоны без Docker
./sh/devops.sh stop             # остановить локальное
./sh/devops.sh lstatus          # статус
./sh/devops.sh llogs web        # лог
./sh/devops.sh deps             # venv + pip
./sh/devops.sh remote           # деплой на VPS
./sh/devops.sh static           # деплой статики
./sh/devops.sh parsers          # рестарт демонов на VPS
./sh/devops.sh diagnostic       # диагностика
./sh/devops.sh status           # local + docker + domain
```

Коды выхода: `0` — успех, `1` — ошибка/неизвестная команда.

### run_docker.sh

```bash
./sh/run_docker.sh start|stop|restart|status|logs|build|clean
```

### dev_deploy.sh

```bash
./sh/dev_deploy.sh [option]
./sh/dev_deploy.sh 11    # только статика
./sh/dev_deploy.sh 12    # полная пересборка
```

| # | Option | Description |
|---|--------|-------------|
| 1 | Server resources | CPU, RAM, Disk |
| 2 | Docker status | Containers, images, networks |
| 3 | Docker logs | Логи всех сервисов |
| 4 | Daemon logs | Погода / инвестиции / тикеры |
| 5 | Nginx status | Сервис и логи |
| 6 | SSL certificates | Certbot |
| 7 | Full system check | Полная диагностика |
| 8 | Checklist | Частые проблемы |
| 9 | Cleanup Docker | Prune |
| 10 | Restart services | Docker/Nginx |
| 11 | Copy static files | Быстрый деплой |
| 12 | Full rebuild | Очистка + upload + build |

**Flow Diagram:** [deploy_scenario.puml](puml/deploy_scenario.puml)

### deploy.conf

| Parameter | Description | Example |
|-----------|-------------|---------|
| `SSH_HOST` | IP сервера | 217.114.8.5 |
| `SSH_USER` | Пользователь SSH | root |
| `DOMAIN` | Домен | wclock5.startupassist.ru |
| `REMOTE_PATH` | Путь на сервере | /var/www/wclock5.startupassist.ru |
| `NGINX_CONFIG_PATH` | Конфиги Nginx | /etc/nginx/sites-available |
| `SSL_EMAIL` | Email для SSL | admin@startupassist.ru |
| `PORT` | Внешний порт Docker | 10405 |
| `DOCKER_PREFIX` | Префикс контейнеров | wclock5 |

### deploy_ignore.txt

Исключения при деплое:

```
.git
.venv
venv
node_modules
__pycache__
*.db
.env.local
sh/
```

---

## PUML Diagrams

| Diagram | Description |
|---------|-------------|
| [deploy_scenario.puml](puml/deploy_scenario.puml) | Server admin script flow |
| [cicd_pipeline.puml](puml/cicd_pipeline.puml) | CI/CD pipeline |
| [container_lifecycle.puml](puml/container_lifecycle.puml) | Container lifecycle |
| [service_communication.puml](puml/service_communication.puml) | Service communication |
| [troubleshooting_flow.puml](puml/troubleshooting_flow.puml) | Troubleshooting flow |
| [backup_recovery.puml](puml/backup_recovery.puml) | Backup & recovery |
| [monitoring_stack.puml](puml/monitoring_stack.puml) | Monitoring stack |

---

> Flask + Docker + Nginx · локальный режим без Docker с 2026-11-05
