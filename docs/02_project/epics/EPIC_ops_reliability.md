---
title: Эпик — Надёжность и ресурсы на Beget (диск, БД, контейнеры, алерты)
fnd: OPS
typ: EPIC
ver: 0.1
updated: 2026-09-29
status: 🚧
---
# Эпик — Надёжность и ресурсы на Beget

Инцидент 2026-09-29: диск Beget `217.114.8.5` дошёл до **100%** (20G из 20G),
`wclock5-inv` умер с `sqlite3.OperationalError: disk I/O error`, попытка создать
`dev.healora.ru` упала с `No space left on device`, nginx не смог перезапуститься.
Разбор показал **две независимые причины**: утечку в `strategy_summary`
(1.5 ГБ в sqlite при 58 уникальных комбинациях) и отсутствие профилактики
на сервере. Эпик закрывает обе + добавляет мониторинг, чтобы следующий раз
инцидент не доезжал до 100%.

## Контекст

### Что было на проде 2026-09-29 (цифры = правда)

```
/dev/vda1  20G  20G  0     100%   ← диск полон
/var/lib/docker  11G  (build cache 1.31G, 57 образов, 31 контейнер)
/var/log/journal  1.9G (journald без vacuum)
/var/lib/apt      630M
/var/www/wclock5.startupassist.ru  1.8G
  └─ parsers/invest/invest_portfolio.db  1.5G  ← утечка
     strategy_summary: 1 122 079 строк
     уникальных (day|source|window) = 58, уникальных msg_id = 42
     1 121 895 строк с пустым window
     колонка raw (JSON) = 693 МБ при avg(length(raw)) = 647 Б
     freelist_count = 0  →  VACUUM в одиночку не помог бы
```

### Причина утечки

Писатель `strategy_summary` — демон `tg_turnover_daemon` (см.
`backlog_20260919.ldn.md`, Цель №1: вечерний снапшота 17.09 не пишется в
таблицу). Таблица не имеет `UNIQUE(day, source, window)` и не перезаписывается:
каждый цикл агрегации добавляет новую строку. За 37 дней (10.08–29.09)
накопилось 1.12M строк ≈ **15–20 МБ/сутки**.

### Память — вторая болевая точка

```
Mem:  1.9Gi total, ~900Mi used, свободно 123–248Mi
Swap: 1.5Gi, занято 1.3Gi              ← thrashing
Load: 112 / 157 / 95                    ← высокий load из-за свопа, не из-за CPU
Топ по свопу: python 140+138+125+46+42 MB, uvicorn 140+58+37 MB, gitea 51 MB
Контейнеров: 31 на 1.9 ГБ RAM
```

Высокий load без единого процесса в топе по CPU = подкачка страниц, а не
вычисления. D-state процессов не было, зомби нет.

### Инцидент без алертов

Диск дошёл до 100% без единого уведомления. Кэш проекта копился без
ретеншена (958 файлов, 826 старше 7 дней). Journald разросся до 1.9G.
Docker build cache и неиспользуемые образы копились месяцами.

## Решение

### 1. Устранение утечки (root cause)

- `strategy_summary`: `UNIQUE(day, source, window)` + `INSERT … ON CONFLICT
  DO UPDATE` (upsert) вместо слепого `INSERT`.
- Ретеншен: `DELETE FROM strategy_summary WHERE day < date('now', '-N day')`
  (по умолчанию N=90, настраивается в `settings`).
- `portfolio_positions` / `portfolio_min` / `portfolio_history` — те же
  проверки роста: 87k / 43k / 34k строк при 1.5 ГБ БД.
- Ежесуточный `VACUUM` (cron, 04:20 МСК — вне пиковой полосы записи
  10:00–19:00) + `PRAGMA journal_size_limit`.

### 2. Гигиена compose

- Убрать битый bind-mount `./invest_portfolio.db:/app/invest_portfolio.db`
  из `wclock`, `invest-parser`, `finam-invest-parser`: на хосте это **пустая
  директория** (Docker создал 16.03.2026), а не файл. Реальная БД доступна
  через `./parsers/invest`.
- Пять образов (`wclock5-app`, `-parser`, `-inv`, `-finam-inv`, `-tickers`)
  собираются из одного `Dockerfile` (`build: .` × 5) и делят слои. Оставить
  один образ и переиспользовать его во всех сервисах.
- `healthcheck` + `mem_limit` для демонов; `stop_grace_period` для внятного
  стопа.

### 3. Автопилот обслуживания и алерты

- Ежесуточный скрипт обслуживания (cron): `journalctl --vacuum-size=200M`,
  `apt-get clean`, `docker builder prune -af --filter until=168h`,
  чистка кэша проекта старше 7 дней.
- Алерт в Telegram при `/` > 85% и при `Mem.available < 200Mi`.
- Watchdog демонов: контейнер `Up`, но не работает (0 B RSS, как
  `wclock5-inv` в инциденте) — это хуже, чем `Exited`, и невидимо для
  `docker ps`.

## Задачи

| Код | Задача | Результат | Статус |
|-----|--------|-----------|--------|
| OPS-01 | Прод: бэкап БД + дедупликация + VACUUM | 1 122 079 → 82 строки, БД 1.5G → **35M**; бэкап `/root/wclock5_backups/invest_portfolio_20260929.db` | ✅ |
| OPS-02 | Прод: чистка ресурсов Beget | `/` 100% → **74%** (7.6G свободно), проект 1.8G → 206M | ✅ |
| OPS-03 | Прод: рестарт упавшего `wclock5-inv` | демон жив, миграции прошли, агрегация идёт | ✅ |
| OPS-04 | Прод: nginx — убрать дубль конфига | `lab.startupassist.ru.bak` вынесен из `sites-enabled` в `/root/nginx-backup/`, warnings = 0 | ✅ |
| OPS-05 | `tg_turnover_daemon`: upsert вместо INSERT | `UNIQUE(day,source,window)` + `ON CONFLICT DO UPDATE` | ⬜ |
| OPS-06 | Ретеншен `strategy_summary` + авто-VACUUM | prune старше N дней + cron 04:20 МСК + `journal_size_limit` | ⬜ |
| OPS-07 | Compose: убрать битый bind-mount | 3 сервиса без `./invest_portfolio.db`, пересоздать контейнеры | ⬜ |
| OPS-08 | Compose: один образ на 5 сервисов | убрать 4 лишние сборки/тега | ⬜ |
| OPS-09 | Compose: healthcheck + mem_limit | падение демона видно, RSS под контролем | ⬜ |
| OPS-10 | Автопилот обслуживания (cron) | journal/apt/build cache/кэш проекта — по расписанию | ⬜ |
| OPS-11 | Алерты диска и памяти | `/` > 85% и `Mem.available < 200Mi` → Telegram | ⬜ |
| OPS-12 | Watchdog «живой, но мёртвый» контейнер | детект 0 B RSS при `Up` | ⬜ |
| OPS-13 | `invest_repo.py:384` — `int('live')` | ValueError на `end_ts=live` от фронта | ⬜ |
| OPS-14 | План по RAM (1.9G / 31 контейнер) | лимиты, консолидация демонов, апгрейд VPS | ⬜ |

## Иллюстрация прод-состояния (цифры = правда)

```
strategy_summary ДО:  1 122 079 строк · raw = 693 МБ · БД 1.5G
strategy_summary ПОСЛЕ:         82 строк · БД 35M · freelist 0
Бэкап до правки: /root/wclock5_backups/invest_portfolio_20260929.db (1.5G)
/: 1.6G free (95-100%) → 7.6G free (74%)
journald 1.9G → 192M · build cache 1.31G → 0 · apt 630M → 0
образы 57 → 23 (reclaimed 3.076G) · кэш проекта 217M → 31M (удалено 826 файлов)
```

```
wclock5-inv ДО рестарта:  Up 7 days · 0B RSS · RestartCount=1 · ExitCode=1
                           sqlite3.OperationalError: disk I/O error
wclock5-inv ПОСЛЕ:        Up · 44 MiB · миграции ок · агрегация идёт
invest_collection_tinkoff_enabled = 0  ← сбор Tinkoff выключен намеренно
invest_collection_finam_enabled   = 1  ← работает finam (2 позиции, 13 514 770 RUB)
```

```
docker-compose.yml (битый бинд, 3 сервиса):
  - ./invest_portfolio.db:/app/invest_portfolio.db
хост: /var/www/wclock5.startupassist.ru/invest_portfolio.db → DIRECTORY (16.03.2026)
```

## Проверка

- `sqlite3 invest_portfolio.db "select count(*) from strategy_summary;"` → 82.
- `ls -lh invest_portfolio.db` → 35M; `pragma freelist_count` → 0.
- Все 5 контейнеров `Up`, RSS суммарно ~227 MiB.
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:10405/` → 200.
- `docker logs wclock5-finam-inv | tail` → «Успешно сохранено 2 позиций».
- `nginx -t 2>&1 | grep -c warn` → 0.
- `df -h /` → 74%.
- `curl /api/invest/turnover` → `{"finam":{…,"capital":13511897.02,
  "total":11636471.68}}` — оборот не потерян после дедупликации
  (регрессия к `total=0` из `backlog_20260919.ldn.md` не вернулась).

## Связи

- Беклоги: `backlog_20260921.ldn.md` (Mn-50..54, открытый `finam sync_trades`),
  `backlog_20260919.ldn.md` (Цель №1 — писатель `strategy_summary` = Mn-30)
- Код: `parsers/invest/tinkoff_invest_daemon.py`, `invest_repo.py`,
  `docker-compose.yml`, `Dockerfile`
- Серверные скрипты (вне репозитория проекта):
  `E:\_dev\60.beget\devops\` → `diagnostic_beget.sh`, `devops.sh`,
  `clean-docker.sh`, `backup-clean.sh`, `security-check.sh`
- ADR: `docs/02_project/ADR/`

## Лист изменений

- **0.1** · 2026-09-29 — создан по итогам инцидента заполнения диска на Beget:
  OPS-01..04 (прод, выполнено: дедупликация `strategy_summary` 1.12M → 82,
  БД 1.5G → 35M, `/` 100% → 74%, рестарт `wclock5-inv`, чистка nginx-дубля),
  OPS-05..14 — план (upsert, ретеншен, compose, автопилот, алерты, watchdog,
  фикс `int('live')`, план по RAM).
