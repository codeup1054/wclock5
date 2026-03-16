#!/bin/bash
# =====================================================================
# T-Bank Sandbox API Monitor — с опциональной расшифровкой (-v)
# =====================================================================

set -e

# ==================== ОБРАБОТКА АРГУМЕНТОВ ====================
REQUESTS=20
VERBOSE=false

while getopts "v" opt; do
  case $opt in
    v) VERBOSE=true ;;
    *) echo "Использование: $0 [-v] [количество_запросов]"; exit 1 ;;
  esac
done
shift $((OPTIND - 1))
REQUESTS="${1:-20}"

# ==================== КОНФИГУРАЦИЯ ====================
TOKEN="t.BeK_Rn0CybcN4-cexLe7A2XnIzOcxbxtijpO5oEvO9bNvRZTW_NWEMx8XzoWmDrOqwkCjHRiFEwEbrx0O00bqA"
ENDPOINT="https://api-invest.tbank.ru/openapi/sandbox/user/accounts"
DELAY_MIN=0.3
DELAY_MAX=1.5
TIMEOUT=10
LOG_FILE="tbank_latency_$(date +%Y%m%d_%H%M%S).log"

# ==================== ИНИЦИАЛИЗАЦИЯ ====================
declare -a CONNECT_TIMES TTFB_TIMES TOTAL_TIMES ERRORS

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

# Проверка зависимостей
command -v bc &>/dev/null || { echo -e "${RED}❌ bc не установлен${NC}"; exit 1; }

# ==================== ФУНКЦИИ ====================
calc_stats() {
    local -n arr=$1
    local valid=()
    for v in "${arr[@]}"; do [[ $v != 0 && $(echo "$v > 0" | bc -l) -eq 1 ]] && valid+=("$v"); done
    local n=${#valid[@]}
    [[ $n -eq 0 ]] && { echo "0 0 0 0 0 0 0 0 0"; return; }
    
    local sorted=($(printf '%s\n' "${valid[@]}" | sort -n))
    local min=${sorted[0]}; local max=${sorted[-1]}
    
    local sum=0; for v in "${valid[@]}"; do sum=$(echo "$sum + $v" | bc -l); done
    local mean=$(echo "scale=6; $sum / $n" | bc -l)
    
    local variance_sum=0
    for v in "${valid[@]}"; do
        diff=$(echo "$v - $mean" | bc -l)
        variance_sum=$(echo "$variance_sum + ($diff * $diff)" | bc -l)
    done
    local stddev=$(echo "scale=6; sqrt($variance_sum / $n)" | bc -l)
    
    local median
    if (( n % 2 == 1 )); then
        median=${sorted[$((n / 2))]}
    else
        local idx1=$((n / 2 - 1)); local idx2=$((n / 2))
        median=$(echo "scale=6; (${sorted[$idx1]} + ${sorted[$idx2]}) / 2" | bc -l)
    fi
    
    local p95_idx=$(echo "scale=0; ($n - 1) * 0.95 / 1" | bc)
    local p99_idx=$(echo "scale=0; ($n - 1) * 0.99 / 1" | bc)
    local p95=${sorted[$p95_idx]}; local p99=${sorted[$p99_idx]}
    local cv=$(echo "scale=2; ($stddev / $mean) * 100" | bc -l)
    
    echo "$min $max $mean $stddev $median $p95 $p99 $cv $n"
}

log() {
    echo "$@" >> "$LOG_FILE"
}

# ==================== ИНИЦИАЛИЗАЦИЯ ЛОГА ====================
log "T-Bank Sandbox API Latency Report"
log "Generated: $(date '+%Y-%m-%d %H:%M:%S %Z')"
log "Endpoint: $ENDPOINT"
log "Token: ${TOKEN:0:10}...${TOKEN: -10}"
log "Requests: $REQUESTS | Delay: ${DELAY_MIN}s–${DELAY_MAX}s"
[[ "$VERBOSE" == true ]] && log "Mode: verbose (с расшифровкой столбцов)"
log ""
log "┌──────────────────────────────────────────────────────────────────────────────────────────────┐"
log "│ ЗАПРОСЫ                                                                                      │"
log "├──────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────────┬─────────────────┤"
log "│  №   │ Connect  │   TTFB   │  Total   │  Status  │   Delay  │   Timestamp  │   Error         │"
log "│      │   (мс)   │   (мс)   │   (мс)   │          │   (с)    │              │                 │"
log "├──────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────────┼─────────────────┤"

# ==================== ВЫПОЛНЕНИЕ ЗАПРОСОВ ====================
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║${NC}  T-Bank Sandbox Monitor                                    ${BLUE}║${NC}"
echo -e "${BLUE}║${NC}  Запросов:$(printf '%3.0f' "$REQUESTS") | Лог: ${YELLOW}$(printf '%36s' "$LOG_FILE") ${NC} ${BLUE}║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

for ((i = 1; i <= REQUESTS; i++)); do
    delay=$(awk -v min=$DELAY_MIN -v max=$DELAY_MAX 'BEGIN{srand(); print min + rand() * (max - min)}')
    
    result=$(curl -ksL -w "connect:%{time_connect}|ttfb:%{time_starttransfer}|total:%{time_total}|code:%{http_code}" \
                  -H "Authorization: Bearer $TOKEN" \
                  -H "Content-Type: application/json" \
                  -o /dev/null --max-time $TIMEOUT \
                  "$ENDPOINT" 2>&1) || result="curl_fail"
    
    if [[ "$result" =~ connect:([0-9.]+)\|ttfb:([0-9.]+)\|total:([0-9.]+)\|code:([0-9]+) ]]; then
        connect="${BASH_REMATCH[1]}"; ttfb="${BASH_REMATCH[2]}"; total="${BASH_REMATCH[3]}"; code="${BASH_REMATCH[4]}"
        
        connect_ms=$(echo "$connect * 1000" | bc -l | xargs printf "%.1f")
        ttfb_ms=$(echo "$ttfb * 1000" | bc -l | xargs printf "%.1f")
        total_ms=$(echo "$total * 1000" | bc -l | xargs printf "%.1f")
        ts_fmt=$(date '+%H:%M:%S')
        
        if [[ $code -eq 200 ]]; then
            CONNECT_TIMES+=("$connect"); TTFB_TIMES+=("$ttfb"); TOTAL_TIMES+=("$total")
            printf "${BLUE}[%3d/%3d]${NC} ${GREEN}✓ 200${NC} C:%6.1fмс T:%6.1fмс Tot:%6.1fмс\n" \
                   "$i" "$REQUESTS" "$connect_ms" "$ttfb_ms" "$total_ms"
            log "│ $(printf '%4d' "$i") │ $(printf '%8.1f' "$connect_ms") │ $(printf '%8.1f' "$ttfb_ms") │ $(printf '%8.1f' "$total_ms") │   200    │ $(printf '%8.2f' "$delay") │ $ts_fmt      │                 │"
        else
            ERRORS+=("HTTP $code")
            printf "${BLUE}[%3d/%3d]${NC} ${YELLOW}⚠ $code${NC}\n" "$i" "$REQUESTS"
            log "│ $(printf '%4d' "$i") │    —     │    —     │    —     │  $code   │ $(printf '%8.2f' "$delay") │ $ts_fmt      │ HTTP $code      │"
            CONNECT_TIMES+=(0); TTFB_TIMES+=(0); TOTAL_TIMES+=(0)
        fi
    else
        ERRORS+=("${result:0:30}")
        printf "${BLUE}[%3d/%3d]${NC} ${RED}✗${NC} %s\n" "$i" "$REQUESTS" "${result:0:40}"
        log "│ $(printf '%4d' "$i") │    —     │    —     │    —     │   ERR    │ $(printf '%8.2f' "$delay") │ $ts_fmt      │ ${result:0:15} │"
        CONNECT_TIMES+=(0); TTFB_TIMES+=(0); TOTAL_TIMES+=(0)
    fi
    
    (( i < REQUESTS )) && sleep "$delay"
done

# ==================== СТАТИСТИКА ====================
read cmin cmax cmean cstd cmed cp95 cp99 ccv csamples < <(calc_stats CONNECT_TIMES)
read tmin tmax tmean tstd tmed tp95 tp99 tcv tsamples < <(calc_stats TTFB_TIMES)
read omin omax omean ostd omed op95 op99 ocv osamples < <(calc_stats TOTAL_TIMES)

cmin_ms=$(echo "$cmin*1000" | bc -l | xargs printf "%.1f")
cmax_ms=$(echo "$cmax*1000" | bc -l | xargs printf "%.1f")
cmean_ms=$(echo "$cmean*1000" | bc -l | xargs printf "%.1f")
cstd_ms=$(echo "$cstd*1000" | bc -l | xargs printf "%.1f")
cmed_ms=$(echo "$cmed*1000" | bc -l | xargs printf "%.1f")
cp95_ms=$(echo "$cp95*1000" | bc -l | xargs printf "%.1f")
cp99_ms=$(echo "$cp99*1000" | bc -l | xargs printf "%.1f")

tmin_ms=$(echo "$tmin*1000" | bc -l | xargs printf "%.1f")
tmax_ms=$(echo "$tmax*1000" | bc -l | xargs printf "%.1f")
tmean_ms=$(echo "$tmean*1000" | bc -l | xargs printf "%.1f")
tstd_ms=$(echo "$tstd*1000" | bc -l | xargs printf "%.1f")
tmed_ms=$(echo "$tmed*1000" | bc -l | xargs printf "%.1f")
tp95_ms=$(echo "$tp95*1000" | bc -l | xargs printf "%.1f")
tp99_ms=$(echo "$tp99*1000" | bc -l | xargs printf "%.1f")

omin_ms=$(echo "$omin*1000" | bc -l | xargs printf "%.1f")
omax_ms=$(echo "$omax*1000" | bc -l | xargs printf "%.1f")
omean_ms=$(echo "$omean*1000" | bc -l | xargs printf "%.1f")
ostd_ms=$(echo "$ostd*1000" | bc -l | xargs printf "%.1f")
omed_ms=$(echo "$omed*1000" | bc -l | xargs printf "%.1f")
op95_ms=$(echo "$op95*1000" | bc -l | xargs printf "%.1f")
op99_ms=$(echo "$op99*1000" | bc -l | xargs printf "%.1f")

# Запись статистики в лог
log "└──────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────────┴─────────────────┘"
log ""
log "┌──────────────────────────────────────────────────────────────────────────────────────────────┐"
log "│ СТАТИСТИКА (мс)                                                                              │"
log "├──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬─────────────────┤"
log "│ Метрика  │   Мин    │   Макс   │  Среднее │   СКО    │ Медиана  │   p95    │      p99        │"
log "├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼─────────────────┤"
log "│ Connect  │ $(printf '%8.1f' "$cmin_ms") │ $(printf '%8.1f' "$cmax_ms") │ $(printf '%8.1f' "$cmean_ms") │ $(printf '%8.1f' "$cstd_ms") │ $(printf '%8.1f' "$cmed_ms") │ $(printf '%8.1f' "$cp95_ms") │ $(printf '%8.1f (%4.1f%%)' "$cp99_ms" "$ccv") │"
log "├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼─────────────────┤"
log "│ TTFB     │ $(printf '%8.1f' "$tmin_ms") │ $(printf '%8.1f' "$tmax_ms") │ $(printf '%8.1f' "$tmean_ms") │ $(printf '%8.1f' "$tstd_ms") │ $(printf '%8.1f' "$tmed_ms") │ $(printf '%8.1f' "$tp95_ms") │ $(printf '%8.1f (%4.1f%%)' "$tp99_ms" "$tcv") │"
log "├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼─────────────────┤"
log "│ Total    │ $(printf '%8.1f' "$omin_ms") │ $(printf '%8.1f' "$omax_ms") │ $(printf '%8.1f' "$omean_ms") │ $(printf '%8.1f' "$ostd_ms") │ $(printf '%8.1f' "$omed_ms") │ $(printf '%8.1f' "$op95_ms") │ $(printf '%8.1f (%4.1f%%)' "$op99_ms" "$ocv") │"
log "└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴─────────────────┘"
log ""
log "Итог: успешных ${osamples}/${REQUESTS} (${#ERRORS[@]} ошибок)"

# ==================== РАСШИФРОВКА (ТОЛЬКО ПРИ -v) ====================
if [[ "$VERBOSE" == true ]]; then
    log ""
    log "┌──────────────────────────────────────────────────────────────────────────────────────────────┐"
    log "│ РАСШИФРОВКА СТОЛБЦОВ                                                                         │"
    log "├──────────────────────────────────────────────────────────────────────────────────────────────┤"
    log "│  №        — Порядковый номер запроса                                                         │"
    log "│  Connect  — Время установки TCP-соединения (мс). Включает DNS + TCP handshake                │"
    log "│  TTFB     — Time To First Byte (мс). Время до первого байта ответа                           │"
    log "│            Включает: Connect + SSL handshake + обработка на сервере                          │"
    log "│  Total    — Общее время запроса (мс). Total = TTFB + передача данных                         │"
    log "│  Status   — HTTP-код ответа (200 = успех, 401 = ошибка авторизации)                          │"
    log "│  Delay    — Случайная задержка перед следующим запросом (сек)                                │"
    log "│  Timestamp— Время выполнения запроса (ЧЧ:ММ:СС)                                              │"
    log "│  Error    — Описание ошибки (если запрос неуспешен)                                          │"
    log "├──────────────────────────────────────────────────────────────────────────────────────────────┤"
    log "│ СТАТИСТИКА:                                                                                  │"
    log "│  СКО      — Стандартное отклонение. Низкое = стабильная задержка                             │"
    log "│  Медиана  — 50-й перцентиль. Устойчива к выбросам                                            │"
    log "│  p95/p99  — 95/99 перцентили. Показывают «хвосты» распределения                              │"
    log "│  CV%      — Коэффициент вариации = (СКО / Среднее) × 100%                                    │"
    log "│            < 15% — стабильно, 15-30% — умеренная вариативность, > 30% — нестабильно         │"
    log "└──────────────────────────────────────────────────────────────────────────────────────────────┘"
    log ""
    log "Примечания:"
    log "  • Все временные метрики в миллисекундах (мс)"
    log "  • Значения '—' = отсутствие данных (ошибка запроса)"
    log "  • Токен частично скрыт для безопасности"
    log "  • Флаг -k: игнорирование SSL-проверки (только для песочницы)"
fi

# ==================== ВЫВОД ИТОГОВ В ТЕРМИНАЛ ====================
echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║${NC}Stats, мс |  Мин   |  Макс  | Средн  |  СКО  |  Мед  |  p95  |  p99  | CV%    ${BLUE}║${NC}"
echo -e "${BLUE}╠══════════════════════════════════════════════════════════════════════════════╣${NC}"
printf "${BLUE}║${NC} %-8s │ %6.1f │ %6.1f │ %6.1f │ %5.1f │ %5.1f │ %5.1f │ %5.1f │ %5.1f%% ${BLUE}║${NC}\n" \
       "Connect" "$cmin_ms" "$cmax_ms" "$cmean_ms" "$cstd_ms" "$cmed_ms" "$cp95_ms" "$cp99_ms" "$ccv"
printf "${BLUE}║${NC} %-8s │ %6.1f │ %6.1f │ %6.1f │ %5.1f │ %5.1f │ %5.1f │ %5.1f │ %5.1f%% ${BLUE}║${NC}\n" \
       "TTFB" "$tmin_ms" "$tmax_ms" "$tmean_ms" "$tstd_ms" "$tmed_ms" "$tp95_ms" "$tp99_ms" "$tcv"
printf "${BLUE}║${NC} %-8s │ %6.1f │ %6.1f │ %6.1f │ %5.1f │ %5.1f │ %5.1f │ %5.1f │ %5.1f%% ${BLUE}║${NC}\n" \
       "Total" "$omin_ms" "$omax_ms" "$omean_ms" "$ostd_ms" "$omed_ms" "$op95_ms" "$op99_ms" "$ocv"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════════════════════╝${NC}"
echo -e "${GREEN}✅ Успешно:${NC} $osamples/${REQUESTS} | ${RED}Ошибки:${NC} ${#ERRORS[@]}"
echo -e "${GREEN}✓ Лог:${NC} $LOG_FILE"
[[ "$VERBOSE" == true ]] && echo -e "${GREEN}💡 Расшифровка:${NC} добавлена в конец лога (режим -v)"