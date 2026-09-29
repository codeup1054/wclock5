FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# hft core
COPY app.py /app/app.py
COPY crm_db.py /app/crm_db.py
COPY analytics_api.py /app/analytics_api.py
COPY analytics_db.py /app/analytics_db.py
COPY news_db.py /app/news_db.py
COPY news_scorer.py /app/news_scorer.py
COPY news_collector.py /app/news_collector.py
COPY text_signature.py /app/text_signature.py
COPY signature_validation.py /app/signature_validation.py
COPY news_ml.py /app/news_ml.py
COPY templates /app/templates
COPY static /app/static

# wclock_repo монтируется volume-ом (invest_repo.py + .db, WAL-доступ rw)
RUN mkdir -p /app/crm /app/wclock_repo/parsers/invest /app/wclock_repo/parsers/mail.ru /app/news

EXPOSE 5001

CMD ["python", "app.py"]