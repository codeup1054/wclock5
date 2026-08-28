#!/bin/bash
# Quick deploy JS/CSS for hatch pattern tuning
# Usage: bash sh/deploy_js.sh [file]
# Default: deploy invest_chart.js

FILE="${1:-static/js/invest_chart.js}"
BASENAME=$(basename "$FILE")

echo "=== Deploy $FILE ==="

MD5_LOCAL=$(md5sum "$FILE" | awk '{print $1}')
echo "Local MD5: $MD5_LOCAL"

scp "$FILE" "root@217.114.8.5:/tmp/$BASENAME" && \
ssh root@217.114.8.5 "cp /tmp/$BASENAME /var/www/wclock5.startupassist.ru/$FILE"

MD5_REMOTE=$(ssh root@217.114.8.5 "md5sum /var/www/wclock5.startupassist.ru/$FILE" | awk '{print $1}')
echo "Remote MD5: $MD5_REMOTE"

if [ "$MD5_LOCAL" = "$MD5_REMOTE" ]; then
    echo "OK"
else
    echo "MISMATCH!"
    exit 1
fi
