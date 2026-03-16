FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Копируем все файлы
COPY . .

RUN pip install --no-cache-dir -r requirements.txt

EXPOSE 5001

# По умолчанию запускает все сервисы (web + парсеры)
# Для отдельных сервисов в docker-compose используется command:
CMD ["sh", "-c", "\
  echo '🚀 Запуск WClock...' && \
  python db_init.py && \
  echo '✅ DB initialized' && \
  python parsers/mail.ru/mail_ru_weather_24hours.py & \
  echo '✅ Weather parser started' & \
  python parsers/invest/tinkoff_invest_daemon.py & \
  echo '✅ Invest parser started' & \
  python parsers/invest/tracked_tickers_daemon.py & \
  echo '✅ Tickers parser started' & \
  exec python app.py"]