# 🕐 WClock DevOps Guide

> Clock dashboard with weather, investments, and battery monitoring

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Scripts](#scripts)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Docker Services](#docker-services)
- [Troubleshooting](#troubleshooting)
- [Maintenance](#maintenance)
- [Appendix: Scripts Reference](#appendix-scripts-reference)
- [PUML Diagrams](#puml-diagrams)

---

## Quick Start

```bash
# Clone and build
cd E:\_dev\10.gpx\gpx_clock_beget\wclock3
docker build -t wclock4 .

# Deploy to server
./sh/dev_deploy.sh
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         LOCAL MACHINE                               │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────┐    ┌──────────────┐    ┌─────────────────────────┐     │
│  │ Docker  │ ─> │ dev_deploy.sh│───▶│ deploy.conf (config)    │     │
│  │  build  │    └──────────────┘    └─────────────────────────┘     │
│  └─────────┘              │                                         │
│                          ▼                                          │
└──────────────────────────┼──────────────────────────────────────────┘
                           │ SSH
                           ▼
┌──────────────────────────┼────────────────────────────────────────────┐
│                     REMOTE SERVER                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                        NGINX                                  │   │
│  │   ┌──────────┐    ┌──────────┐    ┌───────────────────────┐ │   │
│  │   │  Port 80 │───▶│  Port 443│───▶│  SSL Certificates    │ │   │
│  │   │   (HTTP) │    │  (HTTPS) │    │   (Let's Encrypt)    │ │   │
│  │   └──────────┘    └──────────┘    └───────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                    │                                  │
│                                    ▼                                  │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    DOCKER COMPOSE                             │   │
│  │   ┌─────────────┐  ┌─────────────┐  ┌────────────────────┐  │   │
│  │   │ wclock4-app │  │   parser    │  │    wclock4-inv    │  │   │
│  │   │   (FastAPI) │  │  (weather)  │  │   (investments)   │  │   │
│  │   └─────────────┘  └─────────────┘  └────────────────────┘  │   │
│  │   ┌─────────────┐  ┌─────────────┐                          │   │
│  │   │wclock4-tick │  │   network   │                          │   │
│  │   │  (tickers)  │  │  (bridge)   │                          │   │
│  │   └─────────────┘  └─────────────┘                          │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                    │                                  │
│                                    ▼                                  │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                      /var/www/wclock4                        │   │
│  │   ┌──────────┐  ┌────────────┐  ┌─────────┐  ┌──────────┐  │   │
│  │   │  static/ │  │ templates/ │  │ parsers/│  │  *.db    │  │   │
│  │   │(css,js)  │  │  (html)    │  │(daemons)│  │(data)    │  │   │
│  │   └──────────┘  └────────────┘  └─────────┘  └──────────┘  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

---

## Deployment Flow

```
                    ┌─────────────────────┐
                    │  Read deploy.conf   │
                    └──────────┬────────────┘
                               ▼
                    ┌─────────────────────┐
                    │  Copy files (tar)  │─────────────┐
                    └──────────┬────────────┘             │
                               ▼                         ▼
                    ┌─────────────────────┐    ┌─────────────────────┐
                    │  DNS resolved?      │───▶│  Configure Nginx    │
                    └──────────┬────────────┘     │  (HTTP + HTTPS)    │
                         │      │                  └──────────┬────────┘
                        no      │yes                         ▼
                         │      │                  ┌─────────────────────┐
                         ▼      │                  │  Get SSL (certbot) │
                    ┌───────────┐                  └──────────┬──────────┘
                    │    EXIT   │                             ▼
                    │  (error)  │                  ┌─────────────────────┐
                    └───────────┘                  │  Docker Compose     │
                               ▲                   │  up -d --build      │
                               │                   └──────────┬──────────┘
                               │                              ▼
                               │                  ┌─────────────────────┐
                               │                  │  Test URL (curl)   │
                               │                  └──────────┬──────────┘
                               │                         │
                               │                    ┌────┴────┐
                               │                    ▼         ▼
                               │           ┌───────────┐ ┌───────────┐
                               └──────────▶│ SUCCESS!  │ │  FAILED!  │
                                           │           │ │           │
                                           └───────────┘ └───────────┘
```

---

## Scripts

| Script | Description |
|--------|-------------|
| `sh/dev_deploy.sh` | Server admin: diagnostics, logs, restart, deploy |
| `sh/dev_undeploy.sh` | Clean server (remove all containers, SSL, files) |
| `sh/deploy.conf` | Configuration file |

### Menu Options

```
 ./sh/dev_deploy.sh [option]

 1) Server resources     - CPU, RAM, Disk usage
 2) Docker status       - Containers, images, networks
 3) Docker logs         - All services logs
 4) Daemon logs         - Parser logs (invest/weather/tickers)
 5) Nginx status        - Nginx logs and status
 6) SSL certificates    - Certbot certificates info
 7) Full system check  - Complete diagnostics
 8) Checklist           - Common issues check
 9) Cleanup Docker      - Prune containers/images
10) Restart services    - Docker/Nginx restart
11) Copy static files  - Fast deploy (static only)
12) Full rebuild        - Clean + upload + docker build
 0) Exit
```

---

## Configuration

Edit `sh/deploy.conf`:

```bash
# Server
SSH_HOST=217.114.8.5
SSH_USER=root

# Domain
DOMAIN=wclock4.startupassist.ru

# Paths
REMOTE_PATH=/var/www/wclock4.startupassist.ru
NGINX_CONFIG_PATH=/etc/nginx/sites-available

# SSL
SSL_EMAIL=admin@startupassist.ru

# Docker
PORT=10104
DOCKER_PREFIX=wclock4
```

### Port Format

```
XYAZZ  →  XY = project number (00-99)
         A  = subproject (0-9)
         ZZ = version (00-99)

Example: 10104 = project 10, subproject 1, version 04
```

---

## Docker Services

| Service | Container | Description |
|---------|-----------|-------------|
| app | `wclock4-app` | Main FastAPI application |
| weather | `wclock4-parser` | Weather data parser |
| invest | `wclock4-inv` | Investment data parser |
| tickers | `wclock4-tickers` | Tickers price daemon |

### Manual Commands

```bash
# On server
cd /var/www/wclock4

# Start/Stop
docker-compose up -d
docker-compose down

# Logs
docker-compose logs -f
docker-compose logs -f app

# Restart
docker-compose restart

# Rebuild
docker-compose up -d --build
```

---

## Troubleshooting

### Quick Check

```bash
# Run checklist
./sh/dev_deploy.sh 8
```

### Manual Checks

```bash
# DNS
nslookup wclock4.startupassist.ru

# HTTP response
curl -I https://wclock4.startupassist.ru

# Nginx
systemctl status nginx
ss -tlnp | grep -E ':80|:443'

# Docker
docker ps
ss -tlnp | grep 10104
```

### Common Issues

| Issue | Solution |
|-------|----------|
| Port in use | `ss -tlnp \| grep 10104` → change PORT in deploy.conf |
| SSL failed | Check DNS → `certbot certonly --nginx -d domain.ru` |
| 502 Bad Gateway | Check docker logs → `docker ps` |
| Container restart loop | `docker logs container_name` |

---

## Maintenance

### Backup

```bash
# Database is stored in:
# /var/www/wclock4/*.db

# Backup command
ssh user@server "tar -czf wclock4-backup.tar.gz /var/www/wclock4/*.db"
```

### Update

```bash
# Option 11 - Fast update (static files only)
./sh/dev_deploy.sh 11

# Option 12 - Full rebuild
./sh/dev_deploy.sh 12
```

### Clean Server

```bash
# WARNING: Removes everything!
./sh/dev_undeploy.sh
```

---

## Files Structure

```
wclock3/
├── sh/
│   ├── dev_deploy.sh         # Main admin script
│   ├── dev_undeploy.sh      # Clean server
│   ├── deploy.conf          # Configuration
│   └── deploy_ignore.txt    # Exclude patterns
├── static/
│   ├── css/                  # Stylesheets
│   └── js/                  # JavaScript
├── templates/
│   └── index.html            # Main template
├── parsers/                  # Data parsers
│   ├── mail.ru/
│   └── invest/
├── docker-compose.yml        # Docker composition
├── Dockerfile               # Docker image
└── .env                    # Environment variables
```

---

## SSL Certificate

- Auto-generated by Certbot on first deploy
- Valid for 90 days
- Auto-renewal enabled
- Check: `certbot renew --dry-run`

---

## Appendix: Scripts Reference

### dev_deploy.sh

Main server administration script with interactive menu for diagnostics, maintenance, and deployment.

**Location:** `sh/dev_deploy.sh`

**Usage:**
```bash
./sh/dev_deploy.sh [option]
./sh/dev_deploy.sh 11    # Copy static files
./sh/dev_deploy.sh 12    # Full rebuild
```

**Options:**

| # | Option | Description |
|---|--------|-------------|
| 1 | Server resources | CPU, RAM, Disk usage via SSH |
| 2 | Docker status | Containers, images, networks, volumes |
| 3 | Docker logs | Logs for all containers |
| 4 | Daemon logs | Parser logs (invest/weather/tickers) |
| 5 | Nginx status | Nginx service and error/access logs |
| 6 | SSL certificates | Certbot certificates info |
| 7 | Full system check | Complete diagnostic report |
| 8 | Checklist | Common issues verification |
| 9 | Cleanup Docker | Prune containers/images/networks |
| 10 | Restart services | Docker/Nginx restart options |
| 11 | Copy static files | Fast deploy (static only) |
| 12 | Full rebuild | Clean + upload + docker build |
| 0 | Exit | Quit script |

**Flow Diagram:** [deploy_scenario.puml](puml/deploy_scenario.puml)

---

### dev_undeploy.sh

Complete server cleanup script. Removes all project-related data from server.

**Location:** `sh/dev_undeploy.sh`

**Usage:**
```bash
./sh/dev_undeploy.sh
```

**Removes:**
- Docker containers and images
- Nginx config
- SSL certificates
- Project files
- Systemd service (if using uvicorn)

**WARNING:** This action is irreversible!

---

### deploy.conf

Configuration file with server and deployment parameters.

**Location:** `sh/deploy.conf`

**Parameters:**

| Parameter | Description | Example |
|-----------|-------------|---------|
| `SSH_HOST` | Server IP address | 217.114.8.5 |
| `SSH_USER` | SSH username | root |
| `DOMAIN` | Domain name | wclock4.startupassist.ru |
| `REMOTE_PATH` | Project path on server | /var/www/... |
| `NGINX_CONFIG_PATH` | Nginx config path | /etc/nginx/sites-available |
| `SSL_EMAIL` | Email for SSL | admin@... |
| `PORT` | External port | 10104 |
| `DOCKER_PREFIX` | Docker prefix | wclock4 |

---

### deploy_ignore.txt

Patterns to exclude from deployment.

**Location:** `sh/deploy_ignore.txt`

**Default exclusions:**
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

> Built with FastAPI, Docker, Nginx
