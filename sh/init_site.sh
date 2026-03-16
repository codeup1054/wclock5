#!/bin/bash
set -e

# Проверка прав
if [ "$EUID" -ne 0 ]; then
    echo "❌ Этот скрипт должен запускаться от root или с sudo."
    exit 1
fi

# Проверка аргумента
if [ $# -eq 0 ]; then
    echo "❌ Использование: $0 <domain> [email]"
    echo "   Пример: $0 bmitech.ru admin@bmitech.ru"
    exit 1
fi

DOMAIN="$1"
EMAIL="${2:-admin@$DOMAIN}"
WWW_DIR="/var/www/$DOMAIN"
NGINX_CONF="/etc/nginx/sites-available/$DOMAIN"
USER="www-data"

echo "⚙️ Настраиваем сайт $DOMAIN..."

# === 1. Создание директории и index.html (если не существует) ===
if [ ! -d "$WWW_DIR" ]; then
    mkdir -p "$WWW_DIR"
    cat > "$WWW_DIR/index.html" <<EOF
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>Добро пожаловать</title>
</head>
<body>
    <h1>Hello $DOMAIN!</h1>
    <p>Сайт успешно настроен.</p>
</body>
</html>
EOF
    chown -R "$USER:$USER" "$WWW_DIR"
    chmod -R 755 "$WWW_DIR"
else
    echo "📁 Директория $WWW_DIR уже существует. Пропускаем создание index.html."
fi

# === 2. Конфигурация Nginx ===
if [ -f "$NGINX_CONF" ]; then
    echo "⚠️ Конфигурация Nginx для $DOMAIN уже существует. Перезаписываем."
fi

cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;

    root $WWW_DIR;
    index index.html;

    location / {
        try_files \$uri \$uri/ =404;
    }

    location ^~ /.well-known/acme-challenge/ {
        allow all;
        root $WWW_DIR;
    }
}
EOF

# Активация и проверка
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/
if ! nginx -t; then
    echo "❌ Ошибка в конфигурации Nginx!"
    exit 1
fi
systemctl reload nginx

# === 3. Выпуск SSL-сертификата ===
if command -v certbot &> /dev/null; then
    echo "🔐 Запрашиваем SSL-сертификат для $DOMAIN..."
    if certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" \
        --non-interactive --agree-tos --email "$EMAIL" --keep-until-expiring; then
        echo "✅ SSL-сертификат успешно установлен."
    else
        echo "❌ Не удалось получить SSL-сертификат. Проверьте DNS и сетевую доступность."
    fi
else
    echo "⚠️ Certbot не найден. Пропускаем выпуск SSL."
fi

echo "✅ Настройка завершена! Сайт: http://$DOMAIN"