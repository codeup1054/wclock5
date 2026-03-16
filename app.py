# app.py 2026-01-18 

VALID_KEY = "6HKJ809-YUI67-HKJJL-5677-HJKK"
SECRET_MODE_KEY = "INVEST_MODE"

import os
import sqlite3
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
                INSERT INTO battery_logs (datetime, device_id, battery_level)
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








@app.get("/api/weather-map-image")
async def get_weather_map_image():
    # Only allow this in dev or with auth in prod!
    image_path = "static/weather_map.png"
    
    if not os.path.exists(image_path):
        # Generate it (you can trigger this via cron or on-demand)
        await generate_weather_map_screenshot()
    
    return FileResponse(image_path, media_type="image/png")




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
    
    period_map = {
        'day': '-56 day',   # 8 weeks
        'hour': '-14 day',  # 2 weeks
        'minute': '-2 day'  # 2 days
    }
    period = period_map.get(interval, '-14 day')
    
    conn = get_invest_db()
    cur = conn.cursor()

    # Получаем все позиции за указанный период
    cur.execute(f"""
        SELECT 
            timestamp,
            instrument_type,
            name,
            ticker,
            quantity,
            value
        FROM portfolio_positions
        WHERE timestamp >= datetime('now', '{period}')
        ORDER BY timestamp ASC, value DESC
    """)
    rows = cur.fetchall()
    conn.close()

    if not rows:
        return jsonify({})

    # Группируем по timestamp
    result = {}
    for row in rows:
        ts = row["timestamp"]
        if ts not in result:
            result[ts] = []
        
        name = row["name"] or row["ticker"] or "Unknown"
        result[ts].append({
            "type": row["instrument_type"] or "Other",
            "name": name,
            "quantity": round(row["quantity"], 4),
            "value": round(row["value"], 2)
        })

    return jsonify(result)


# === API для тикеров (TGLD@) ===
TRACKED_TICKERS_DB_PATH = os.path.join(os.path.dirname(__file__), "parsers", "invest", "tracked_tickers.db")

@app.route("/api/invest/ticker/<ticker>")
def api_invest_ticker(ticker):
    if not os.path.exists(TRACKED_TICKERS_DB_PATH):
        return jsonify({"error": "Ticker DB not found"}), 404
    
    conn = sqlite3.connect(TRACKED_TICKERS_DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    
    # FIGI mapping
    FIGI_MAP = {
        "TGLD@": "TCS80A101X50",
        "GDH6": "FUTGOLD03260"
    }
    figi = FIGI_MAP.get(ticker.upper())
    if not figi:
        return jsonify({"error": "Ticker not found"}), 404
    
    # Получаем данные за последние 7 дней
    cur.execute("""
        SELECT timestamp, price, ticker, class_code
        FROM last_prices
        WHERE figi = ? AND timestamp >= datetime('now', '-7 day')
        ORDER BY timestamp ASC
    """, (figi,))
    rows = cur.fetchall()
    conn.close()
    
    if not rows:
        return jsonify({"error": "No data for ticker"}), 404
    
    # Формируем данные
    prices = []
    for row in rows:
        prices.append({
            "timestamp": row["timestamp"],
            "price": round(row["price"], 2),
            "ticker": row["ticker"],
            "class_code": row["class_code"]
        })
    
    # Вычисляем дневное и недельное изменение
    if len(prices) >= 2:
        # Последняя цена
        current_price = prices[-1]["price"]
        
        # Цена в начале дня (первая за сегодня)
        today_start = None
        for p in reversed(prices):
            if p["timestamp"] >= prices[-1]["timestamp"][:10]:
                today_start = p["price"]
            else:
                break
        
        # Цена неделю назад
        week_ago_price = None
        if len(prices) >= 7:
            week_ago_price = prices[0]["price"]
        
        # Вычисляем изменения
        day_change = 0
        day_change_pct = 0
        if today_start and today_start > 0:
            day_change = current_price - today_start
            day_change_pct = (day_change / today_start) * 100
        
        week_change = 0
        week_change_pct = 0
        if week_ago_price and week_ago_price > 0:
            week_change = current_price - week_ago_price
            week_change_pct = (week_change / week_ago_price) * 100
    else:
        current_price = prices[0]["price"] if prices else 0
        day_change = 0
        day_change_pct = 0
        week_change = 0
        week_change_pct = 0
    
    return jsonify({
        "ticker": ticker,
        "figi": figi,
        "current_price": current_price,
        "day_change": round(day_change, 2),
        "day_change_pct": round(day_change_pct, 2),
        "week_change": round(week_change, 2),
        "week_change_pct": round(week_change_pct, 2),
        "prices": prices
    })


@app.route("/api/invest/tickers")
def api_invest_tickers():
    """Получить данные по всем отслеживаемым тикерам"""
    interval = request.args.get('interval', 'hour')
    
    period_map = {
        'day': '-56 day',
        'hour': '-14 day',
        'minute': '-2 day'
    }
    period = period_map.get(interval, '-14 day')
    
    if not os.path.exists(TRACKED_TICKERS_DB_PATH):
        return jsonify({"error": "Ticker DB not found"}), 404
    
    conn = sqlite3.connect(TRACKED_TICKERS_DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    
    # Получаем все тикеры за указанный период
    cur.execute(f"""
        SELECT DISTINCT figi, ticker, class_code
        FROM last_prices
        WHERE timestamp >= datetime('now', '{period}')
    """)
    ticker_rows = cur.fetchall()
    
    result = {}
    for t_row in ticker_rows:
        figi = t_row["figi"]
        ticker = t_row["ticker"] or figi
        
        cur.execute(f"""
            SELECT timestamp, price
            FROM last_prices
            WHERE figi = ? AND timestamp >= datetime('now', '{period}')
            ORDER BY timestamp ASC
        """, (figi,))
        price_rows = cur.fetchall()
        
        prices = [{"timestamp": r["timestamp"], "price": round(r["price"], 2)} for r in price_rows]
        
        if prices:
            current_price = prices[-1]["price"]
            
            # Day change (первая цена за сегодня)
            today_date = prices[-1]["timestamp"][:10]
            today_prices = [p for p in prices if p["timestamp"][:10] >= today_date]
            day_start_price = today_prices[0]["price"] if today_prices else current_price
            
            day_change = current_price - day_start_price
            day_change_pct = (day_change / day_start_price * 100) if day_start_price > 0 else 0
            
            # Week change
            week_start_price = prices[0]["price"] if len(prices) > 0 else current_price
            week_change = current_price - week_start_price
            week_change_pct = (week_change / week_start_price * 100) if week_start_price > 0 else 0
            
            result[ticker] = {
                "figi": figi,
                "current_price": current_price,
                "day_change": round(day_change, 2),
                "day_change_pct": round(day_change_pct, 2),
                "week_change": round(week_change, 2),
                "week_change_pct": round(week_change_pct, 2),
                "prices": prices
            }
    
    conn.close()
    return jsonify(result)


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