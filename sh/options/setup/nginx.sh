#!/bin/bash
# Setup Nginx

SCRIPT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
source "$SCRIPT_DIR/sh/deploy.conf"

SSH_TARGET="${SSH_USER}@${SSH_HOST}"

echo "=== Setup Nginx ==="
echo "Domain: $DOMAIN"
echo "Port: $PORT"
echo ""
read -p "Continue? (yes/no): " CONFIRM
[ "$CONFIRM" != "yes" ] && echo "Cancelled." && exit 0

echo "Creating Nginx config..."
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
echo "=== Nginx setup complete ==="
