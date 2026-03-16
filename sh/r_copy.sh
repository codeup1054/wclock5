#!/bin/bash

IMAGE_NAME="weather-clock"
CONTAINER_NAME="weather-clock-app"
HOST_PORT=5001
CONTAINER_PORT=5001
PWD_DIR=$(pwd)

# Параметр: fast для быстрого запуска без пересборки
MODE=$1

if [ "$MODE" != "fast" ]; then
  echo "=== Building Docker image: $IMAGE_NAME ==="
  docker build --no-cache -t $IMAGE_NAME .
else
  echo "=== Fast mode: skipping Docker build ==="
fi

echo "=== Stopping old container (if exists): $CONTAINER_NAME ==="
docker stop $CONTAINER_NAME 2>/dev/null || true

echo "=== Removing old container (if exists): $CONTAINER_NAME ==="
docker rm $CONTAINER_NAME 2>/dev/null || true

echo "=== Running new container: $CONTAINER_NAME ==="
docker run -d \
    --name $CONTAINER_NAME \
    -p $HOST_PORT:$CONTAINER_PORT \
    -v "$PWD_DIR:/app" \
    $IMAGE_NAME

echo "=== Done ==="
docker ps --filter "name=$CONTAINER_NAME"
