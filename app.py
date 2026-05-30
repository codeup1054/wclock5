# app.py 2026-01-18 

VALID_KEY = "6HKJ809-YUI67-HKJJL-5677-HJKK"
SECRET_MODE_KEY = "INVEST_MODE"

import os
import sqlite3
import json
import time
from datetime import datetime
from flask import Flask, jsonify, render_template, request, make_response

# === Инициализация БД ===
from db_init import init_db
print("🔧 Инициализация базы данных...")
init_db()  # ← вызывается СРАЗУ при импорте app.py

# Пути
BASE_DIR = os.path.dirname(__file__)
DB_PATH = os.path.join(BASE_DIR, "parsers", "mail.ru", "odintsovo_weather.db")
INVEST_DB_PATH = os.path.join(BASE_DIR, "parsers", "invest", "invest_portfolio.db")

app = Flask(__name__, 
            template_folder="templates", 
            static_folder="static",  
            static_url_path="/static"
            )

# app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0

# ================================
# Вспомогательные функции
# ================================

def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def get_weather():
    """Возвращает последний факт погоды и краткий прогноз"""
    conn = get_db_connection()
    cursor = conn.cursor()

    # Текущая погода
    cursor.execute("SELECT * FROM current ORDER BY collected_at DESC LIMIT 1")
    current = cursor.fetchone()
    if current:
        fact = dict(current)
    else:
        fact = {}

    # Почасовой прогноз (берём первый час)
    cursor.execute("SELECT * FROM hourly_forecast ORDER BY collected_at DESC LIMIT 12")
    forecast_rows = cursor.fetchall()
    if forecast_rows:
        short_range = dict(forecast_rows[0])
        long_range = dict(forecast_rows[-1])

        fact |= {k: v for k, v in short_range.items() if k not in fact}

        forecast_summary = {
            "parts": [dict(long_range)],
        }
    else:
        forecast_summary = {"parts": [], "sunrise": "", "sunset": "", "moon_code": 0}

    conn.close()
    return {"fact": fact, "forecast_summary": forecast_summary, "timeline": []}

def get_settings():
    """Возвращает все настройки из таблицы settings"""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT key, value FROM settings")
    rows = cursor.fetchall()
    conn.close()
    return {row["key"]: row["value"] for row in rows}

def update_setting(key, value):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))
    conn.commit()
    conn.close()

# ================================
# API эндпоинты
# ================================

@app.route("/api/weather")
def api_weather():
    return jsonify(get_weather())

@app.route("/api/charts_data")
def get_charts_data():
    import sqlite3
    from flask import jsonify

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    query = """
    WITH last_update AS (
        SELECT MAX(collected_at) AS last_time FROM hourly_forecast
    ),
    base AS (
        SELECT
            datetime(time) AS datetime,
            temperature,
            humidity,
            pressure,
            precip_prob,
            wind_speed,
            feels_like
        FROM hourly_forecast
    ),
    aggregated AS (
        SELECT
            datetime(
                strftime('%Y-%m-%d %H:00', datetime),
                '-' || (CAST(strftime('%H', datetime) AS INTEGER) % 2) || ' hours'
            ) AS timestamp,
            ROUND(AVG(temperature), 1) AS temperature,
            ROUND(AVG(humidity), 1) AS humidity,
            ROUND(AVG(pressure), 1) AS pressure,
            ROUND(AVG(precip_prob), 1) AS precip_prob,
            ROUND(AVG(wind_speed), 1) AS wind_speed,
            ROUND(AVG(feels_like), 1) AS feels_like
        FROM base
        GROUP BY timestamp
    )
    SELECT * FROM aggregated
    WHERE datetime(timestamp) BETWEEN
          datetime((SELECT last_time FROM last_update), '-12 hours')
      AND datetime((SELECT last_time FROM last_update), '+24 hours')
    ORDER BY timestamp ASC;
    """

    try:
        rows = cur.execute(query).fetchall()
        conn.close()
        data = [dict(row) for row in rows]
        return jsonify(data)
    except Exception as e:
        conn.close()
        return jsonify({"error": str(e)}), 500

@app.route('/api/battery', methods=['GET', 'POST'])
def battery():
    try:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()

        if request.method == 'POST':
            # Проверяем Content-Type и парсим JSON
            if request.is_json:
                data = request.get_json()
            else:
                # Если не JSON — возвращаем ошибку
                return jsonify({'error': 'Content-Type must be application/json'}), 400

            device_id = data.get('device_id_local')

            battery_level = data.get('value')  # или 'battery_level' — смотрите, как отправляется

            # timestamp = data.get('timestamp', datetime.now(timezone.utc).isoformat())

            if not (device_id and battery_level is not None):
                return jsonify({'error': 'device_id_local and value required'}), 400

            # Проверяем, что battery_level — число
            try:
                battery_level = int(battery_level)
                if not (0 <= battery_level <= 100):
                    raise ValueError()
            except (ValueError, TypeError):
                return jsonify({'error': 'value must be integer 0–100'}), 400

            # Вставляем запись
            cur.execute("""
                INSERT OR REPLACE INTO battery_logs (datetime, device_id, battery_level)
                VALUES (datetime('now'), ?, ?)
            """, (device_id, battery_level))
            conn.commit()

            _str = device_id + " " + str(battery_level)

            return jsonify({'status': 'ok', 'message': _str})

        else:  # GET
            device_id = request.args.get('device_id_local')
            interval = request.args.get('interval', 'hour')
            
            period_map = {
                'day': '-56 day',
                'hour': '-14 day',
                'minute': '-2 day'
            }
            period = period_map.get(interval, '-14 day')
            
            limit_map = {
                'day': 5000,
                'hour': 3000,
                'minute': 600
            }
            limit = int(request.args.get('limit', limit_map.get(interval, 3000)))

            if not device_id:
                return jsonify({'error': 'device_id_local required'}), 400

            cur.execute(f"""
                    SELECT 
                        strftime('%Y-%m-%d %H:%M', datetime) AS minute_group,
                        AVG(battery_level) AS avg_level
                    FROM battery_logs
                    WHERE device_id = ? AND datetime >= datetime('now', '{period}')
                    GROUP BY (strftime('%s', datetime) / 600)  -- 300 секунд = 5 минут
                    ORDER BY minute_group DESC
                LIMIT ?
            """, (device_id, limit))

            rows = cur.fetchall()
            return jsonify([
                {'datetime': r[0], 'battery_level': r[1]} for r in rows
            ])

    except Exception as e:
        print(f"❌ Ошибка в /api/battery: {e}")
        return jsonify({'error': str(e)}), 500

    finally:
        conn.close()

@app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    if request.method == "POST":
        data = request.json
        for key, value in data.items():
            update_setting(key, value)
        return jsonify({"status": "ok"})
    else:
        return jsonify(get_settings())


# === API для конфигов панелей по device_id ===
@app.route("/api/panel_config/<device_id>", methods=["GET"])
def get_panel_config(device_id):
    """Получить конфиг панелей для конкретного устройства"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT config_type, config_json, updated_at 
        FROM panel_configs 
        WHERE device_id = ?
    """, (device_id,))
    
    row = cursor.fetchone()
    conn.close()
    
    if row:
        return jsonify({
            "device_id": row["device_id"],
            "config_type": row["config_type"],
            "config_json": json.loads(row["config_json"]),
            "updated_at": row["updated_at"]
        })
    else:
        return jsonify({"error": "Config not found"}), 404


@app.route("/api/panel_config/<device_id>", methods=["POST"])
def save_panel_config(device_id):
    """Сохранить конфиг панелей для конкретного устройства"""
    data = request.get_json()
    config_type = data.get("config_type", "desktop")  # desktop или tablet
    config_json = data.get("config_json")
    
    if not config_json:
        return jsonify({"error": "config_json required"}), 400
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
        INSERT OR REPLACE INTO panel_configs (device_id, config_type, config_json, updated_at)
        VALUES (?, ?, ?, datetime('now'))
    """, (device_id, config_type, json.dumps(config_json)))
    
    conn.commit()
    conn.close()
    
    return jsonify({"status": "ok", "device_id": device_id})








@app.get("/api/weather-map-image")
async def get_weather_map_image():
    # Only allow this in dev or with auth in prod!
    image_path = "static/weather_map.png"
    
    if not os.path.exists(image_path):
        # Generate it (you can trigger this via cron or on-demand)
        await generate_weather_map_screenshot()
    
    return FileResponse(image_path, media_type="image/png")




CACHE_DIR = os.path.join(BASE_DIR, "cache")

def invest_cache_key(endpoint, **params):
    safe = {"-": "m", ".": "_", "/": "_", " ": "_"}
    key = endpoint
    for k, v in sorted(params.items()):
        if v is not None:
            key += f"_{k}={str(v).translate(str.maketrans(safe))}"
    return key

def cached_invest(endpoint, db_paths, params, generator):
    """Lazy cache: serve cached JSON if DB mtimes are older than cache."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    cache_file = os.path.join(CACHE_DIR, invest_cache_key(endpoint, **params) + ".json")
    
    # Max mtime among all relevant DB files
    db_mtime = 0
    for path in db_paths if isinstance(db_paths, list) else [db_paths]:
        if os.path.exists(path):
            db_mtime = max(db_mtime, os.path.getmtime(path))
    
    # If cache exists and is newer than all DBs → serve cache
    if os.path.exists(cache_file) and os.path.getmtime(cache_file) >= db_mtime:
        with open(cache_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    
    # Generate fresh data
    data = generator()
    
    # Write cache atomically
    tmp = cache_file + ".tmp"
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, cache_file)
    
    return data

# === Инвестиции: API ===
BASE_DIR = os.path.dirname(__file__)
INVEST_DB_PATH = os.path.join(BASE_DIR, "parsers", "invest", "invest_portfolio.db")

def get_invest_db():
    if not os.path.exists(INVEST_DB_PATH):
        print(f"❌ БД не найдена: {INVEST_DB_PATH}")
        raise FileNotFoundError("Invest DB not found")
    conn = sqlite3.connect(INVEST_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

# @app.route("/api/invest/portfolio")
# def api_invest_portfolio():

#     print(f"🔍 [DEBUG] INVEST_DB_PATH = {INVEST_DB_PATH}")
#     print(f"📁 [DEBUG] Файл существует: {os.path.exists(INVEST_DB_PATH)}")

#     conn = get_invest_db()
#     cur = conn.cursor()
#     cur.execute("""
#         SELECT instrument_type, name, ticker, quantity, price, value
#         FROM portfolio_positions
#         WHERE timestamp = (SELECT MAX(timestamp) FROM portfolio_positions)
#         ORDER BY value DESC
#     """)
#     rows = cur.fetchall()
#     conn.close()

#     positions = [
#         {
#             "type": row["instrument_type"],
#             "name": row["name"] or row["ticker"],
#             "quantity": round(row["quantity"], 4),
#             "value": round(row["value"], 2)
#         }
#         for row in rows if row["value"] > 0
#     ]
#     return jsonify({"positions": positions})

@app.route("/api/invest/history")
def api_invest_history():
    interval = request.args.get('interval', 'hour')
    period = request.args.get('period', '-30 day')
    bucket_size = {'minute': 600, 'hour': 3600, 'day': 86400}.get(interval, 3600)

    def generate():
        conn = get_invest_db()
        cur = conn.cursor()

        cur.execute("""
            SELECT timestamp, SUM(value) AS total, MAX(value) AS max_pos
            FROM portfolio_positions
            WHERE timestamp >= datetime('now', ?)
            GROUP BY timestamp
            ORDER BY timestamp ASC
        """, (period,))
        rows = cur.fetchall()

        if not rows:
            cur.execute("""
                SELECT timestamp, SUM(value) AS total, MAX(value) AS max_pos
                FROM portfolio_positions
                GROUP BY timestamp
                ORDER BY timestamp ASC
            """)
            rows = cur.fetchall()

        if not rows:
            conn.close()
            return {}

        aggregated = {}
        latest_ts = None

        for row in rows:
            ts = row["timestamp"]
            total = round(row["total"], 2)
            dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
            bucket_epoch = int(dt.timestamp() / bucket_size) * bucket_size
            aggregated[str(bucket_epoch)] = (ts, total)
            if latest_ts is None or ts > latest_ts:
                latest_ts = ts

        cur.execute("""
            SELECT instrument_type, name, ticker, quantity, value
            FROM portfolio_positions
            WHERE timestamp = ?
            ORDER BY value DESC
        """, (latest_ts,))
        latest_positions = [
            {
                "type": r["instrument_type"] or "Other",
                "name": r["name"] or r["ticker"] or "Unknown",
                "quantity": round(r["quantity"], 4),
                "value": round(r["value"], 2),
            }
            for r in cur.fetchall()
        ]

        conn.close()

        result = {}
        for bucket_key in sorted(aggregated.keys()):
            ts, total = aggregated[bucket_key]
            result[ts] = [{"type": "total", "name": "Портфель", "value": total}]
        if latest_ts:
            result[latest_ts] = latest_positions
        return result

    data = cached_invest("history", INVEST_DB_PATH, {"interval": interval, "period": period}, generate)
    return jsonify(data)


# === API для тикеров (TGLD@) ===
TRACKED_TICKERS_DB_PATH = os.path.join(os.path.dirname(__file__), "parsers", "invest", "tracked_tickers.db")

@app.route("/api/invest/ticker/<ticker>")
def api_invest_ticker(ticker):
    if not os.path.exists(TRACKED_TICKERS_DB_PATH):
        return jsonify({"error": "Ticker DB not found"}), 404
    
    interval = request.args.get('interval', 'hour')
    period = request.args.get('period', '-28 day')
    bucket_size = {'minute': 600, 'hour': 3600, 'day': 86400}.get(interval, 3600)
    figi = {"TGLD@": "TCS80A101X50", "GDH6": "FUTGOLD03260"}.get(ticker.upper())
    if not figi:
        return jsonify({"error": "Ticker not found"}), 404

    def generate():
        conn = sqlite3.connect(TRACKED_TICKERS_DB_PATH)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("""
            SELECT timestamp, price, ticker, class_code
            FROM last_prices
            WHERE figi = ? AND timestamp >= datetime('now', ?)
            ORDER BY timestamp ASC
        """, (figi, period))
        rows = cur.fetchall()
        if not rows:
            cur.execute("""
                SELECT timestamp, price, ticker, class_code
                FROM last_prices
                WHERE figi = ?
                ORDER BY timestamp ASC
            """, (figi,))
            rows = cur.fetchall()
        conn.close()
        if not rows:
            return {"_error": "No data for ticker", "_error_code": 404}

        aggregated = {}
        for row in rows:
            dt = datetime.fromisoformat(row["timestamp"].replace('Z', '+00:00'))
            bucket_key = str(int(dt.timestamp() / bucket_size) * bucket_size)
            aggregated[bucket_key] = {
                "timestamp": row["timestamp"],
                "price": round(row["price"], 2),
                "ticker": row["ticker"],
                "class_code": row["class_code"]
            }
        prices = [aggregated[k] for k in sorted(aggregated.keys())]
        if len(prices) >= 2:
            current_price = prices[-1]["price"]
            today_start = next((p["price"] for p in reversed(prices) if p["timestamp"] < prices[-1]["timestamp"][:10]), None)
            day_change = current_price - today_start if today_start and today_start > 0 else 0
            day_change_pct = (day_change / today_start * 100) if today_start and today_start > 0 else 0
            month_change = current_price - prices[0]["price"] if prices[0]["price"] > 0 else 0
            month_change_pct = (month_change / prices[0]["price"] * 100) if prices[0]["price"] > 0 else 0
        else:
            current_price = prices[0]["price"] if prices else 0
            day_change = day_change_pct = month_change = month_change_pct = 0
        
        return {
            "ticker": ticker, "figi": figi,
            "current_price": current_price,
            "day_change": round(day_change, 2), "day_change_pct": round(day_change_pct, 2),
            "month_change": round(month_change, 2), "month_change_pct": round(month_change_pct, 2),
            "prices": prices
        }

    data = cached_invest(f"ticker_{ticker}", TRACKED_TICKERS_DB_PATH,
                         {"interval": interval, "period": period}, generate)
    if isinstance(data, dict) and data.get("_error"):
        return jsonify({"error": data["_error"]}), data.get("_error_code", 500)
    return jsonify(data)


@app.route("/api/invest/tickers")
def api_invest_tickers():
    interval = request.args.get('interval', 'hour')
    period = request.args.get('period', '-28 day')
    bucket_size = {'minute': 600, 'hour': 3600, 'day': 86400}.get(interval, 3600)

    def generate():
        if not os.path.exists(TRACKED_TICKERS_DB_PATH):
            return {"_error": "Ticker DB not found", "_error_code": 404}
        conn = sqlite3.connect(TRACKED_TICKERS_DB_PATH)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("""
            SELECT figi, ticker, class_code, timestamp, price
            FROM last_prices
            WHERE timestamp >= datetime('now', ?)
            ORDER BY figi, timestamp ASC
        """, (period,))
        rows = cur.fetchall()
        if not rows:
            cur.execute("""
                SELECT figi, ticker, class_code, timestamp, price
                FROM last_prices
                ORDER BY figi, timestamp ASC
            """)
            rows = cur.fetchall()
        conn.close()

        ticker_groups = {}
        for r in rows:
            figi = r["figi"]
            if figi not in ticker_groups:
                ticker_groups[figi] = {"ticker": r["ticker"] or figi, "class_code": r["class_code"], "prices": {}}
            dt = datetime.fromisoformat(r["timestamp"].replace('Z', '+00:00'))
            bucket_key = str(int(dt.timestamp() / bucket_size) * bucket_size)
            ticker_groups[figi]["prices"][bucket_key] = {"timestamp": r["timestamp"], "price": round(r["price"], 2)}

        result = {}
        for figi, group in ticker_groups.items():
            prices = [group["prices"][k] for k in sorted(group["prices"].keys())]
            if not prices:
                continue
            cp = prices[-1]["price"]
            today_prices = [p for p in prices if p["timestamp"][:10] >= prices[-1]["timestamp"][:10]]
            ds = today_prices[0]["price"] if today_prices else cp
            dc = cp - ds
            dp = (dc / ds * 100) if ds > 0 else 0
            ms = prices[0]["price"]
            mc = cp - ms
            mp = (mc / ms * 100) if ms > 0 else 0
            result[group["ticker"]] = {
                "figi": figi, "current_price": cp,
                "day_change": round(dc, 2), "day_change_pct": round(dp, 2),
                "month_change": round(mc, 2), "month_change_pct": round(mp, 2),
                "prices": prices
            }
        return result

    data = cached_invest("tickers", TRACKED_TICKERS_DB_PATH,
                         {"interval": interval, "period": period}, generate)
    if isinstance(data, dict) and data.get("_error"):
        return jsonify({"error": data["_error"]}), data.get("_error_code", 500)
    return jsonify(data)


@app.route("/api/set_mode", methods=["POST"])
def api_set_mode():
    """Установить режим отображения (invest или basic)"""
    data = request.get_json()
    mode = data.get("mode", "basic")
    
    resp = make_response(jsonify({"status": "ok", "mode": mode}))
    resp.set_cookie("wclock_mode", mode, max_age=60*60*24*30)  # 30 days
    return resp


@app.route("/api/get_mode")
def api_get_mode():
    """Получить текущий режим"""
    mode = request.cookies.get("wclock_mode", "basic")
    # Также проверяем KEY в параметрах
    key_mode = request.args.get("KEY")
    if key_mode == VALID_KEY:
        mode = "invest"
    return jsonify({"mode": mode})




# ================================
# Главная страница
# ================================

@app.route("/")
def index():
    # Проверяем KEY в параметрах или cookie
    key_param = request.args.get('KEY')
    cookie_mode = request.cookies.get('wclock_mode', 'basic')
    
    show_invest = (key_param == VALID_KEY) or (cookie_mode == 'invest')
    return render_template("index.html", show_invest=show_invest, PAGE_REВOAD_MIN=int(get_settings().get("PAGE_RELOAD_MIN", 4320)))




# ================================
# Запуск
# ================================

if __name__ == "__main__":
    print("🚀 Запуск сервера Flask...")
    # app.config['TEMPLATES_AUTO_RELOAD'] = True
    
    PORT = int(os.environ.get("PORT", "5001")) 
    print(f"🌐 Порт: {PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=True)