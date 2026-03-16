#!/bin/bash
# Full setup (Nginx + SSL + Deploy)

SCRIPT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
source "$SCRIPT_DIR/sh/deploy.conf"

SSH_TARGET="${SSH_USER}@${SSH_HOST}"
PROJECT_ROOT="$SCRIPT_DIR"

echo "=== Full Setup: Nginx + SSL + Deploy ==="
echo "Domain: $DOMAIN"
echo "Port: $PORT"
read -p "Continue? (yes/no): " CONFIRM
[ "$CONFIRM" != "yes" ] && echo "Cancelled." && exit 0

# Step 1: Setup Nginx (without SSL - certbot will add it)
echo "1/3 Setting up Nginx..."
ssh "$SSH_TARGET" "
    cat > /etc/nginx/sites-available/$DOMAIN << 'EOF'
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_redirect off;
        proxy_buffering off;
        proxy_http_version 1.1;
    }

    location /static {
        alias $REMOTE_PATH/static;
    }
}
EOF

    ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
    nginx -t && systemctl reload nginx || echo 'Nginx config error!'
"

# Step 2: Setup SSL
echo "2/3 Getting SSL certificate..."
ssh "$SSH_TARGET" "
    certbot --nginx -d $DOMAIN --redirect --agree-tos -m $SSL_EMAIL --non-interactive
"

# Step 2.5: Update nginx with enhanced config (SSL + caching)
echo "2.5/3 Updating nginx config..."
ssh "$SSH_TARGET" "
    cat > /etc/nginx/sites-available/$DOMAIN << 'EOF'
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_redirect off;
        proxy_buffering off;
        proxy_http_version 1.1;
    }

    location /static {
        alias $REMOTE_PATH/static;
        expires 1y;
        add_header Cache-Control \"public, immutable\";
    }

    location ~ /\\. {
        deny all;
    }
}
EOF
    nginx -t && systemctl reload nginx || echo 'Nginx config error!'
"

# Step 3: Deploy
echo "3/3 Deploying..."
IGNORE_FILE="${SCRIPT_DIR}/sh/deploy_ignore.txt"
ssh "$SSH_TARGET" "mkdir -p $REMOTE_PATH"
tar -X "$IGNORE_FILE" -czf - -C "$PROJECT_ROOT" . | \
    ssh "$SSH_TARGET" "tar -xzf - -C $REMOTE_PATH"

ssh "$SSH_TARGET" "
    cd $REMOTE_PATH
    PORT=$PORT docker-compose up -d --build
"

echo ""
echo "=== Full setup complete ==="
echo "URL: https://$DOMAIN"
