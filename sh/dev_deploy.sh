#!/bin/bash

# ============================================
# Server Admin Script - Diagnostics & Maintenance
# Usage: ./dev_deploy.sh [option]
#   1) Server resources
#   2) Docker status
#   3) Docker logs
#   4) Daemon logs
#   5) Nginx status
#   6) SSL certificates
#   7) Full system check
#   8) Checklist
#   9) Cleanup Docker
#   10) Restart services
#   11) Copy static files
#   12) Full rebuild (clean + upload + docker build)
#   13) Setup Nginx
#   14) Setup SSL (certbot)
#   15) Full setup (Nginx + SSL + deploy)
#   0) Exit
# ============================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/deploy.conf"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: Config file not found: $CONFIG_FILE"
    exit 1
fi

source "$CONFIG_FILE"

SSH_TARGET="${SSH_USER}@${SSH_HOST}"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CHOICE="${1:-}"

if [ -z "$CHOICE" ]; then
    echo "========================================"
    echo "  WClock Server Admin"
    echo "========================================"
    echo ""
    echo "1) Server resources (CPU, RAM, Disk)"
    echo "2) Docker status & containers"
    echo "3) Docker logs (all services)"
    echo "4) Daemon logs (parsers)"
    echo "5) Nginx status & logs"
    echo "6) SSL certificates info"
    echo "7) Full system check"
    echo "8) Checklist (common issues)"
    echo "9) Cleanup Docker (prune)"
    echo "10) Restart services"
    echo "11) Copy static files only"
    echo "12) Full rebuild (clean + upload + docker build)"
    echo "13) Setup Nginx config"
    echo "14) Setup SSL (certbot)"
    echo "15) Full setup (Nginx + SSL + deploy)"
    echo "0) Exit"
    echo ""
    
    read -p "Select option: " CHOICE
fi

case $CHOICE in
    1)
        echo "=== Server Resources ==="
        ssh "$SSH_TARGET" "
            echo '--- Uptime ---'
            uptime
            echo ''
            echo '--- CPU ---'
            top -bn1 | head -5
            echo ''
            echo '--- RAM ---'
            free -h
            echo ''
            echo '--- Disk ---'
            df -h | grep -E '/dev/|Filesystem'
            echo ''
            echo '--- Top Processes ---'
            ps aux --sort=-%mem | head -6
        "
        ;;

    2)
        echo "=== Docker Containers ==="
        ssh "$SSH_TARGET" "docker ps -a"
        echo ""
        echo "=== Docker Images ==="
        ssh "$SSH_TARGET" "docker images"
        echo ""
        echo "=== Docker Networks ==="
        ssh "$SSH_TARGET" "docker network ls"
        echo ""
        echo "=== Docker Volumes ==="
        ssh "$SSH_TARGET" "docker volume ls"
        ;;

    3)
        echo "=== Docker Logs ==="
        echo "1) wclock-app"
        echo "2) weather-parser"
        echo "3) invest-parser"
        echo "4) tickers-parser"
        echo "5) All containers"
        read -p "Select: " LOG_CHOICE

        case $LOG_CHOICE in
            1) CONTAINER="${DOCKER_PREFIX}-app" ;;
            2) CONTAINER="${DOCKER_PREFIX}-parser" ;;
            3) CONTAINER="${DOCKER_PREFIX}-inv" ;;
            4) CONTAINER="${DOCKER_PREFIX}-tickers" ;;
            5) 
                echo "=== All Container Logs ==="
                ssh "$SSH_TARGET" "docker ps --format '{{.Names}}' | while read n; do echo \"=== \$n ===\"; docker logs --tail 30 \$n 2>&1; done"
                exit 0
                ;;
        esac

        CONTAINER_ID=$(ssh "$SSH_TARGET" "docker ps -q -f name=$CONTAINER")
        if [ -n "$CONTAINER_ID" ]; then
            ssh "$SSH_TARGET" "docker logs $CONTAINER_ID --tail 50 2>&1"
        else
            echo "Container $CONTAINER not found"
        fi
        ;;

    4)
        echo "=== Daemon Logs (last 30 lines) ==="
        echo ""
        echo "--- invest-parser ---"
        ssh "$SSH_TARGET" "docker logs \$(docker ps -q -f name=${DOCKER_PREFIX}-inv) --tail 30 2>&1 | tail -20"
        ssh "$SSH_TARGET" "docker logs \$(docker ps -q -f name=${DOCKER_PREFIX}-tickers) --tail 30 2>&1 | tail -20"
        ssh "$SSH_TARGET" "docker logs \$(docker ps -q -f name=${DOCKER_PREFIX}-parser) --tail 30 2>&1 | tail -20"
        ;;

    5)
        echo "=== Nginx Status ==="
        ssh "$SSH_TARGET" "systemctl status nginx --no-pager | head -10"
        echo ""
        echo "=== Nginx Error Log (last 20) ==="
        ssh "$SSH_TARGET" "tail -20 /var/log/nginx/error.log"
        echo ""
        echo "=== Nginx Access Log (last 20) ==="
        ssh "$SSH_TARGET" "tail -20 /var/log/nginx/access.log"
        ;;

    6)
        echo "=== SSL Certificates ==="
        ssh "$SSH_TARGET" "certbot certificates"
        echo ""
        echo "=== SSL Expiry Check ==="
        ssh "$SSH_TARGET" "certbot renew --dry-run 2>&1 | head -10"
        ;;

    7)
        echo "=== Full System Check ==="
        echo ""
        echo "--- DNS Check ---"
        nslookup "$DOMAIN" 2>/dev/null | grep -A1 "$DOMAIN" || echo "DNS lookup failed"
        echo ""
        
        echo "--- Server Response ---"
        HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/")
        echo "HTTP Code: $HTTP_CODE"
        echo ""
        
        echo "--- System Resources ---"
        ssh "$SSH_TARGET" "free -h && df -h / | tail -1"
        echo ""
        
        echo "--- Docker Containers ---"
        ssh "$SSH_TARGET" "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
        echo ""
        
        echo "--- Nginx Ports ---"
        ssh "$SSH_TARGET" "ss -tlnp | grep -E ':80|:443'"
        echo ""
        
        echo "--- SSL Certificate ---"
        ssh "$SSH_TARGET" "certbot certificates 2>/dev/null | grep -A2 '$DOMAIN' || echo 'No SSL found'"
        ;;
        
    8)
        echo "=== Checklist ==="
        echo ""
        echo "[ ] DNS resolves to server IP"
        nslookup "$DOMAIN" 2>/dev/null | grep -q "217.114.8.5" && echo "  ✓ DNS OK" || echo "  ✗ DNS FAIL"
        
        echo "[ ] Server responds on HTTPS"
        HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/")
        [ "$HTTP_CODE" = "200" ] && echo "  ✓ HTTP 200 OK" || echo "  ✗ HTTP $HTTP_CODE"
        
        echo "[ ] Nginx running"
        ssh "$SSH_TARGET" "systemctl is-active nginx" | grep -q "active" && echo "  ✓ Nginx OK" || echo "  ✗ Nginx FAIL"
        
        echo "[ ] Docker containers running"
        COUNT=$(ssh "$SSH_TARGET" "docker ps -q | wc -l")
        [ "$COUNT" -gt "0" ] && echo "  ✓ Docker OK ($COUNT containers)" || echo "  ✗ Docker FAIL"
        
        echo "[ ] SSL certificate valid"
        ssh "$SSH_TARGET" "certbot certificates 2>/dev/null | grep -q '$DOMAIN'" && echo "  ✓ SSL OK" || echo "  ✗ SSL FAIL"
        
        echo "[ ] Port $PORT listening"
        ssh "$SSH_TARGET" "ss -tlnp | grep -q ':$PORT'" && echo "  ✓ Port $PORT OK" || echo "  ✗ Port $PORT FAIL"
        
        echo ""
        echo "--- Quick Fixes ---"
        echo "1) Restart Docker"
        echo "2) Restart Nginx"
        echo "3) Rebuild containers"
        read -p "Apply fix? (1-3 or n): " FIX_CHOICE
        case $FIX_CHOICE in
            1)
                ssh "$SSH_TARGET" "cd $REMOTE_PATH && docker-compose restart"
                echo "Docker restarted."
                ;;
            2)
                ssh "$SSH_TARGET" "systemctl restart nginx"
                echo "Nginx restarted."
                ;;
            3)
                ssh "$SSH_TARGET" "cd $REMOTE_PATH && docker-compose down && PORT=$PORT docker-compose up -d --build"
                echo "Containers rebuilt."
                ;;
        esac
        ;;

    9)
        echo "WARNING: This will remove:"
        echo "  - Stopped containers"
        echo "  - Unused networks"
        echo "  - Build cache"
        echo "  - Dangling images"
        echo ""
        read -p "Continue? (yes/no): " CONFIRM
        if [ "$CONFIRM" = "yes" ]; then
            echo "=== Cleaning Docker ==="
            ssh "$SSH_TARGET" "
                echo '--- Stopped containers ---'
                docker container prune -f
                echo ''
                echo '--- Unused networks ---'
                docker network prune -f
                echo ''
                echo '--- Dangling images ---'
                docker image prune -f
                echo ''
                echo '--- Build cache ---'
                docker builder prune -f
                echo ''
                echo '--- All unused ---'
                docker system prune -f
            "
            echo "=== Cleanup complete ==="
        else
            echo "Cancelled."
        fi
        ;;

    10)
        echo "1) Restart Docker containers"
        echo "2) Restart Nginx"
        echo "3) Restart uvicorn (if running)"
        echo "4) Full restart (Docker + Nginx)"
        read -p "Select: " RESTART_CHOICE
        
        case $RESTART_CHOICE in
            1)
                ssh "$SSH_TARGET" "
                    cd $REMOTE_PATH
                    PORT=$PORT docker-compose restart
                "
                echo "Docker restarted."
                ;;
            2)
                ssh "$SSH_TARGET" "systemctl restart nginx && echo 'Nginx restarted.'"
                ;;
            3)
                echo "Docker containers restarted."
                ;;
            4)
                ssh "$SSH_TARGET" "
                    cd $REMOTE_PATH
                    PORT=$PORT docker-compose restart
                    systemctl restart nginx
                "
                echo "Full restart complete."
                ;;
        esac
        ;;
        
    11)
        echo "=== Copy Static Files ==="
        echo "Copying static files to server..."
        IGNORE_FILE="${SCRIPT_DIR}/deploy_ignore.txt"
        ssh "$SSH_TARGET" "mkdir -p $REMOTE_PATH/static $REMOTE_PATH/templates"
        tar -X "$IGNORE_FILE" -czf - -C "$PROJECT_ROOT" static templates | \
            ssh "$SSH_TARGET" "tar -xzf - -C $REMOTE_PATH"
        echo "Static files copied."
        echo ""
        echo "Restarting containers to apply changes..."
        ssh "$SSH_TARGET" "cd $REMOTE_PATH && docker-compose restart"
        echo "Done."
        ;;
        
    12)
        echo "=== Full Rebuild ==="
        echo "WARNING: This will remove all containers, rebuild and restart!"
        read -p "Continue? (yes/no): " CONFIRM
        if [ "$CONFIRM" != "yes" ]; then
            echo "Cancelled."
            exit 0
        fi
        
        echo "1. Cleaning Docker on server..."
        ssh "$SSH_TARGET" "
            cd $REMOTE_PATH
            docker-compose down 2>/dev/null || true
            docker container prune -f
            docker image prune -f
            docker builder prune -f
        "
        
        echo "2. Copying project files..."
        IGNORE_FILE="${SCRIPT_DIR}/deploy_ignore.txt"
        ssh "$SSH_TARGET" "mkdir -p $REMOTE_PATH"
        tar -X "$IGNORE_FILE" -czf - -C "$PROJECT_ROOT" . | \
            ssh "$SSH_TARGET" "tar -xzf - -C $REMOTE_PATH"
        
        echo "3. Building and starting Docker containers..."
        ssh "$SSH_TARGET" "
            cd $REMOTE_PATH
            PORT=$PORT docker-compose up -d --build
        "
        
        echo "4. Checking status..."
        ssh "$SSH_TARGET" "docker ps --format 'table {{.Names}}\t{{.Status}}'"
        
        echo ""
        echo "=== Full rebuild complete ==="
        ;;

    13)
        echo "=== Setup Nginx ==="
        echo "Domain: $DOMAIN"
        echo "Port: $PORT"
        echo ""
        read -p "Continue? (yes/no): " CONFIRM
        if [ "$CONFIRM" != "yes" ]; then
            echo "Cancelled."
            exit 0
        fi

        echo "Creating Nginx config..."
        ssh "$SSH_TARGET" "
            # Create nginx config using sed replacements
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

            # Enable site
            ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/

            # Remove default or conflicting
            rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

            # Test and reload
            nginx -t && systemctl reload nginx || echo 'Nginx config error!'
        "
        echo "=== Nginx setup complete ==="
        ;;

    14)
        echo "=== Setup SSL (Certbot) ==="
        echo "Domain: $DOMAIN"
        echo "Email: $SSL_EMAIL"
        echo ""
        echo "IMPORTANT: Nginx must be running and domain must resolve!"
        read -p "Continue? (yes/no): " CONFIRM
        if [ "$CONFIRM" != "yes" ]; then
            echo "Cancelled."
            exit 0
        fi

        echo "Getting SSL certificate..."
        ssh "$SSH_TARGET" "
            certbot --nginx -d $DOMAIN --redirect --agree-tos -m $SSL_EMAIL --non-interactive
        "
        echo "=== SSL setup complete ==="
        echo "Check: certbot certificates"
        ;;

    15)
        echo "=== Full Setup: Nginx + SSL + Deploy ==="
        echo "Domain: $DOMAIN"
        echo "Port: $PORT"
        read -p "Continue? (yes/no): " CONFIRM
        if [ "$CONFIRM" != "yes" ]; then
            echo "Cancelled."
            exit 0
        fi

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
        IGNORE_FILE="${SCRIPT_DIR}/deploy_ignore.txt"
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
        ;;
        
    0)
        echo "Exit."
        exit 0
        ;;
    
    *)
        echo "Invalid option."
        exit 1
        ;;
esac
