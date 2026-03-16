#!/bin/bash
# Setup SSL (certbot)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$SCRIPT_DIR/sh/deploy.conf"

SSH_TARGET="${SSH_USER}@${SSH_HOST}"

echo "=== Setup SSL (Certbot) ==="
echo "Domain: $DOMAIN"
echo "Email: $SSL_EMAIL"
echo ""
echo "IMPORTANT: Nginx must be running and domain must resolve!"
read -p "Continue? (yes/no): " CONFIRM
[ "$CONFIRM" != "yes" ] && echo "Cancelled." && exit 0

echo "Getting SSL certificate..."
ssh "$SSH_TARGET" "
    certbot --nginx -d $DOMAIN --redirect --agree-tos -m $SSL_EMAIL --non-interactive
"
echo "=== SSL setup complete ==="
echo "Check: certbot certificates"
