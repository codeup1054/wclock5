#!/bin/bash
# Simple helper to deploy project files to your remote server (frontend or full code)
# Usage examples:
#   ./dep.sh                                 # deploy default frontend set (templates/index.html, css, weather_chart.js)
#   FULL=1 ./dep.sh                          # deploy common backend+frontend set (app.py, db_init.py, requirements.txt, templates, static, parsers)
#   HOST=your.host USER=root PORT=22 ./dep.sh
#   ./dep.sh static/js/weather_chart.js static/js/battery.js   # multiple files
#   FILES="static/js/weather_chart.js static/js/battery.js" ./dep.sh
#   REMOTE_DIR=/root/wclock/static/js ./dep.sh static/js/*.js  # copy all to remote dir (flat)
#   REMOTE_PATH=/root/wclock/static/js/weather_chart.js ./dep.sh static/js/weather_chart.js  # copy to exact path
#   REMOTE_POST_CMD='cd /root/wclock && docker compose up -d --build' FULL=1 ./dep.sh  # optional remote post-deploy command
#
# Env vars:
#   HOST, USER, PORT, REMOTE_DIR or REMOTE_PATH, FULL=0|1, FILES, REMOTE_POST_CMD
#
# Requires: openssh-client (scp), ssh

set -euo pipefail

# Defaults
# Default set (frontend) now includes index.html + css + js
DEFAULT_FILES=(
  "templates/index.html"
  "static/css/wclock.css"
#  "static/js/cookie.js"
#  "static/js/battery.js"
  "static/js/weather_chart.js"
)
# Full project set for code deploy
DEFAULT_FULL_ITEMS=(
  "app.py"
  "db_init.py"
  "requirements.txt"
  "templates"
  "static"
  "parsers"
)
REMOTE_USER="${USER:-root}"
REMOTE_HOST="${HOST:-217.114.8.5}"
REMOTE_PORT="${PORT:-22}"
REMOTE_DIR="${REMOTE_DIR:-}"             # e.g. /root/wclock or /root/wclock/static/js
REMOTE_PATH="${REMOTE_PATH:-}"           # exact remote file path (only for single local file)
FULL_MODE="${FULL:-0}"
REMOTE_POST_CMD="${REMOTE_POST_CMD:-}"

# --- Time utilities ---
# Return local file mtime as epoch seconds
local_mtime_epoch() {
  # $1: local path
  if command -v stat >/dev/null 2>&1; then
    if stat --version >/dev/null 2>&1; then
      stat -c %Y "$1" 2>/dev/null || true
    else
      stat -f %m "$1" 2>/dev/null || true
    fi
  else
    # POSIX perl fallback
    perl -e 'print((stat shift)[9])' "$1" 2>/dev/null || true
  fi
}

# Return formatted timestamp for epoch seconds
fmt_ts() {
  # $1: epoch
  if [ -z "${1:-}" ]; then echo "(n/a)"; return; fi
  date -d "@${1}" "+%F %T %Z" 2>/dev/null || date -r "$1" "+%F %T %Z" 2>/dev/null || echo "$1"
}

# Return remote file mtime as epoch seconds (empty if file not exists)
remote_mtime_epoch() {
  # $1: remote absolute path
  remote_path="$1"
  ssh -p "$REMOTE_PORT" "${REMOTE_USER}@${REMOTE_HOST}" "if [ -e \"$remote_path\" ]; then if stat --version >/dev/null 2>&1; then stat -c %Y \"$remote_path\"; else stat -f %m \"$remote_path\"; fi; else echo ''; fi" 2>/dev/null || true
}

# Print time comparison log for a pair (local src, remote target)
print_time_compare() {
  # $1: local path, $2: remote path
  local src="$1"; local rpath="$2"
  if [ -d "$src" ]; then
    echo "Time check: directory '$src' — skipping timestamp compare"
    return
  fi
  local l_epoch r_epoch
  l_epoch="$(local_mtime_epoch "$src")"
  r_epoch="$(remote_mtime_epoch "$rpath")"
  local l_fmt r_fmt
  l_fmt="$(fmt_ts "$l_epoch")"
  if [ -n "$r_epoch" ]; then
    r_fmt="$(fmt_ts "$r_epoch")"
    local diff=$(( l_epoch - r_epoch ))
    echo "Time check: local $l_fmt | remote $r_fmt | diff ${diff}s"
  else
    echo "Time check: local $l_fmt | remote (not found)"
  fi
}

# Gather files from args or FILES env (or FULL mode)
if [ "$FULL_MODE" = "1" ]; then
  FILE_LIST=("${DEFAULT_FULL_ITEMS[@]}")
elif [ "$#" -gt 0 ]; then
  FILE_LIST=("$@")
elif [ -n "${FILES:-}" ]; then
  # shellcheck disable=SC2206
  FILE_LIST=(${FILES})
else
  FILE_LIST=("${DEFAULT_FILES[@]}")
fi

# Validate sources exist (files or directories)
for f in "${FILE_LIST[@]}"; do
  if [ ! -e "$f" ]; then
    echo "Error: $f not found. Run from repository root." >&2
    exit 1
  fi
done

# Determine remote destination mode
MODE="dir"
if [ -n "$REMOTE_PATH" ]; then
  MODE="path"
elif [ -z "$REMOTE_DIR" ]; then
  # Default remote dir now points to project root on the server
  REMOTE_DIR="/root/wclock"
fi

# Ensure remote directory exists when using dir mode
if [ "$MODE" = "dir" ]; then
  echo "Ensuring remote dir exists: ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}"
  ssh -p "$REMOTE_PORT" "${REMOTE_USER}@${REMOTE_HOST}" "mkdir -p '$REMOTE_DIR'"
fi

# Copy items
if [ "$MODE" = "path" ]; then
  if [ "${#FILE_LIST[@]}" -ne 1 ]; then
    echo "Error: REMOTE_PATH can be used only with a single local file." >&2
    exit 1
  fi
  src="${FILE_LIST[0]}"
  if [ -d "$src" ]; then
    echo "Error: REMOTE_PATH cannot be used with a directory. Use REMOTE_DIR or default project root." >&2
    exit 1
  fi
  echo "Deploying $src -> ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH} (port ${REMOTE_PORT})"
  print_time_compare "$src" "$REMOTE_PATH"
  scp -P "$REMOTE_PORT" "$src" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}"
else
  for src in "${FILE_LIST[@]}"; do
    if [ "$REMOTE_DIR" = "/root/wclock" ]; then
      # Preserve relative paths when deploying to project root
      target="${REMOTE_DIR%/}/$src"
      remote_subdir="$(dirname "$target")"
      echo "Ensuring remote subdir exists: ${REMOTE_USER}@${REMOTE_HOST}:${remote_subdir}"
      ssh -p "$REMOTE_PORT" "${REMOTE_USER}@${REMOTE_HOST}" "mkdir -p '$remote_subdir'"
      # Show time info before copy
      print_time_compare "$src" "$target"
      if [ -d "$src" ]; then
        echo "Deploying directory $src -> ${REMOTE_USER}@${REMOTE_HOST}:${remote_subdir}/"
        scp -r -P "$REMOTE_PORT" "$src" "${REMOTE_USER}@${REMOTE_HOST}:${remote_subdir}/"
        continue
      fi
    else
      # Backward-compatible: copy into a single directory (flatten)
      base_name="$(basename "$src")"
      target="${REMOTE_DIR%/}/$base_name"
      # Show time info before copy
      print_time_compare "$src" "$target"
    fi
    echo "Deploying $src -> ${REMOTE_USER}@${REMOTE_HOST}:$target (port ${REMOTE_PORT})"
    if [ -d "$src" ]; then
      scp -r -P "$REMOTE_PORT" "$src" "${REMOTE_USER}@${REMOTE_HOST}:$(dirname "$target")/"
    else
      scp -P "$REMOTE_PORT" "$src" "${REMOTE_USER}@${REMOTE_HOST}:$target"
    fi
  done
fi

# Optional remote post-deploy command
if [ -n "$REMOTE_POST_CMD" ]; then
  echo "Running remote post-deploy command..."
  ssh -p "$REMOTE_PORT" "${REMOTE_USER}@${REMOTE_HOST}" "$REMOTE_POST_CMD"
fi

echo "Done. If browser caches JS/CSS, hard-refresh (Ctrl+F5) or bump the version query in templates/index.html (e.g., weather_chart.js?3, wclock.css?v=4)."