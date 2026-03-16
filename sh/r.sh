#!/bin/bash

# r.sh - Управление WClock (альтернативный скрипт)
# Использует docker-compose как основной метод

cd "$(dirname "$0")"

# Запуск через docker-compose
exec ./run_docker.sh "$@"