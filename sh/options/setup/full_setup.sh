#!/bin/bash
# Full setup (Nginx + SSL + Deploy)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$SCRIPT_DIR/sh/deploy.conf"

SSH_TARGET="${SSH_USER}@${SSH_HOST}"
PROJECT_ROOT="$(cd "$SCRIPT_DIR" && pwd)"

echo "=== Full Setup: Nginx + SSL + Deploy ==="
echo "Domain: $DOMAIN"
echo "Port: $PORT"
read -p "Continue? (yes/no): " CONFIRM
[ "$CONFIRM" != "yes" ] && echo "Cancelled." && exit 0

# Step 1: Setup Nginx
echo "1/3 Setting up Nginx..."
ssh "$SSH_TARGET" "
    cat > /etc/nginx/sites-available/$DOMAIN << EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://localhost:$PORT;
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
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
