#!/bin/bash
# Checklist - common issues

source "$(dirname "$0")/../../deploy.conf"
SSH_TARGET="${SSH_USER}@${SSH_HOST}"

echo "=== Checklist ==="
echo ""

# DNS
echo "1) DNS resolution:"
ssh "$SSH_TARGET" "host $DOMAIN 2>/dev/null || nslookup $DOMAIN 2>/dev/null | head -5"
echo ""

# HTTP
echo "2) HTTP response:"
ssh "$SSH_TARGET" "curl -s -o /dev/null -w '%{http_code}' http://localhost:$PORT/ || echo 'FAIL'"
echo ""

# Nginx
echo "3) Nginx:"
ssh "$SSH_TARGET" "systemctl is-active nginx" | grep -q "active" && echo "  ✓ OK" || echo "  ✗ FAIL"
echo ""

# SSL
echo "4) SSL:"
ssh "$SSH_TARGET" "certbot certificates 2>/dev/null | grep -q '$DOMAIN'" && echo "  ✓ OK" || echo "  ✗ FAIL"
echo ""

# Docker
echo "5) Docker containers:"
ssh "$SSH_TARGET" "docker ps -q | wc -l" | xargs echo "  Running:"
echo ""

# Port
echo "6) Port $PORT:"
ssh "$SSH_TARGET" "ss -tlnp | grep -q ':$PORT '" && echo "  ✓ OK" || echo "  ✗ FAIL"
