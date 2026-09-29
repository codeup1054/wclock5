# app.py 2026-01-18 

VALID_KEY = "6HKJ809-YUI67-HKJJL-5677-HJKK"
SECRET_MODE_KEY = "INVEST_MODE"

import os
import sqlite3
import json
import time
import traceback
from datetime import datetime, timedelta, timezone
from flask import Flask, jsonify, render_template, request, make_response, url_for


def _int_or_none(v):
    """start_ts/end_ts из query — int либо None."""
    if v is None:
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None

# === Инициализация БД ===
from db_init import init_db
import invest_repo
from panel_mediator import PanelMediator, stable_token
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

# Авто cache-busting: no-cache для статики и HTML-страниц
@app.after_request
def add_no_cache(response):
    if request.path.startswith('/static/') or response.mimetype == 'text/html':
        response.cache_control.no_cache = True
        response.cache_control.no_store = True
        response.cache_control.must_revalidate = True
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
    elif request.path.startswith('/api/'):
        response.cache_control.no_store = True
        response.cache_control.max_age = 0
        response.headers['Pragma'] = 'no-cache'
    return response

# Версионирование статики по mtime: URL меняется при каждом изменении файла,
# поэтому даже браузеры, игнорирующие no-cache, получают свежую версию
@app.template_global()
def surl(filename):
    fp = os.path.join(app.static_folder, filename)
    try:
        v = int(os.stat(fp).st_mtime)
    except OSError:
        v = 0
    return f"{url_for('static', filename=filename)}?v={v}"

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
    result = {row["key"]: row["value"] for row in rows}
    # Настройки сбора данных инвест-демонов живут в инвест-БД (их читают демоны).
    result.update(_get_invest_collection_settings())
    return result

# Ключи настроек, которые хранятся в инвест-БД (демоны читают их оттуда), а не в портальной.
_INVEST_COLLECTION_KEYS = {"invest_collection_tinkoff_enabled", "invest_collection_finam_enabled"}

def _get_invest_collection_settings():
    try:
        conn = sqlite3.connect(INVEST_DB_PATH, timeout=10)
        conn.execute("PRAGMA busy_timeout = 5000")
        cursor = conn.cursor()
        cursor.execute("SELECT key, value FROM settings WHERE key IN (?, ?)", tuple(_INVEST_COLLECTION_KEYS))
        rows = cursor.fetchall()
        conn.close()
        return {row[0]: row[1] for row in rows}
    except Exception:
        return {}

def _write_invest_collection_settings(updates):
    try:
        conn = sqlite3.connect(INVEST_DB_PATH, timeout=10)
        conn.execute("PRAGMA busy_timeout = 10000")
        try:
            conn.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            for key, value in updates.items():
                conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        print(f"⚠️ Не удалось записать инвест-настройку сбора: {e}", flush=True)

def update_setting(key, value):
    # Инвест-настройки пишем в инвест-БД, чтобы их видели демоны без перезапуска.
    if key in _INVEST_COLLECTION_KEYS:
        _write_invest_collection_settings({key: value})
        return
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
    """Тот же payload, что и секция charts_data медиатора; теперь одна точка
    истины — хелпер _read_charts_payload (см. ниже)."""
    conn = get_db_connection()
    conn.close()
    return jsonify(_read_charts_payload(db_path=DB_PATH))


def _read_charts_payload(db_path=None):
    """payload секции charts_data (тот же SQL, что и /api/charts_data).
    Возврат: list[dict] либо {"_error":…}."""
    import sqlite3

    db_path = db_path or DB_PATH
    conn = sqlite3.connect(db_path)
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
        return data
    except Exception as e:
        conn.close()
        return {"_error": str(e)}

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
            period_param = request.args.get('period')
            
            period_map = {
                'day': '-56 day',
                'hour': '-14 day',
                'minute': '-2 day'
            }
            period = period_param if period_param else period_map.get(interval, '-14 day')
            
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


@app.route("/api/user_settings/<device_id>", methods=["GET"])
def get_user_settings(device_id):
    """Получить все настройки пользователя для device_id"""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT key, value FROM user_settings WHERE device_id = ?", (device_id,))
    rows = cursor.fetchall()
    conn.close()
    settings = {row["key"]: row["value"] for row in rows}
    # Настройки сбора инвест-демонов живут в инвест-БД.
    settings.update(_get_invest_collection_settings())
    return jsonify(settings)


@app.route("/api/user_settings/<device_id>", methods=["POST"])
def save_user_settings(device_id):
    """Сохранить настройки пользователя для device_id"""
    data = request.get_json()
    if not data or "settings" not in data:
        return jsonify({"error": "settings object required"}), 400
    conn = get_db_connection()
    cursor = conn.cursor()
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    for key, value in data["settings"].items():
        cursor.execute("""
            INSERT OR REPLACE INTO user_settings (device_id, key, value, updated_at)
            VALUES (?, ?, ?, ?)
        """, (device_id, key, str(value), now))
    conn.commit()
    conn.close()
    # Инвест-настройки сбора дублируем в инвест-БД, чтобы их видели демоны.
    invest_updates = {k: v for k, v in data["settings"].items() if k in _INVEST_COLLECTION_KEYS}
    if invest_updates:
        _write_invest_collection_settings(invest_updates)
    return jsonify({"status": "ok"})








@app.get("/api/weather-map-image")
async def get_weather_map_image():
    # Only allow this in dev or with auth in prod!
    image_path = "static/weather_map.png"
    
    if not os.path.exists(image_path):
        # Generate it (you can trigger this via cron or on-demand)
        await generate_weather_map_screenshot()
    
    return FileResponse(image_path, media_type="image/png")




CACHE_DIR = os.path.join(BASE_DIR, "cache")

# In-memory TTL cache для /api/invest/turnover (оборот дня меняется редко,
# а баннер дёргает эндпоинт каждый тик — 60с; не молотить SQLite на каждый запрос).
_turnover_cache = {"data": None, "at": 0}

def invest_cache_key(endpoint, **params):
    safe = {"-": "m", ".": "_", "/": "_", " ": "_"}
    key = endpoint
    for k, v in sorted(params.items()):
        if v is not None:
            key += f"_{k}={str(v).translate(str.maketrans(safe))}"
    return key

def cached_invest(endpoint, db_paths, params, generator, ttl=None):
    """Lazy cache: serve cached JSON if fresh.

    Правило свежести:
    - ttl задан: кэш жив минимум `ttl` секунд с момента генерации,
      независимо от mtime БД (БД пишется каждые ~10с днём, а данные
      меняются раз в бакет, поэтому даже свежий mtime = «нужен рекэш»).
    - ttl=None: свежесть = кэш новее всех DB (историческое поведение).
    """
    import time as _time
    os.makedirs(CACHE_DIR, exist_ok=True)
    cache_file = os.path.join(CACHE_DIR, invest_cache_key(endpoint, **params) + ".json")
    
    # Max mtime among all relevant DB files
    db_mtime = 0
    for path in db_paths if isinstance(db_paths, list) else [db_paths]:
        if os.path.exists(path):
            db_mtime = max(db_mtime, os.path.getmtime(path))
    
    now = _time.time()
    # If cache exists and is fresh per TTL (or per DB mtime) → serve cache
    if os.path.exists(cache_file):
        cache_mtime = os.path.getmtime(cache_file)
        fresh = (now - cache_mtime) < ttl if ttl else (cache_mtime >= db_mtime)
        if fresh:
            try:
                with open(cache_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except (json.JSONDecodeError, OSError):
                try:
                    os.remove(cache_file)
                except OSError:
                    pass
    
    # Generate fresh data
    data = generator()
    
    # Don't cache error responses
    if isinstance(data, dict) and data.get("_error"):
        return data
    
    # Write cache atomically
    tmp = cache_file + "." + str(os.getpid()) + ".tmp"
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
    try:
        os.replace(tmp, cache_file)
    except (FileNotFoundError, OSError):
        pass  # another request already cached
    
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
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn

@app.route("/api/invest/history")
def api_invest_history():
    interval = request.args.get('interval', 'hour')
    period = request.args.get('period', '-30 day')
    start_ts = _int_or_none(request.args.get('start_ts'))
    end_ts = _int_or_none(request.args.get('end_ts'))
    after_ts = _int_or_none(request.args.get('after_ts'))

    t0 = time.time()
    data = _invest_history_payload(interval, period, start_ts, end_ts, after_ts)
    elapsed = int((time.time() - t0) * 1000)
    keys = len(data) if isinstance(data, dict) else 0
    print(f"[INVEST] history interval={interval} after={after_ts is not None} keys={keys} ms={elapsed}", flush=True)
    if isinstance(data, dict) and data.get("_error"):
        return jsonify({"error": data["_error"]}), data.get("_error_code", 500)
    return jsonify(data)


@app.route("/api/invest/turnover")
def api_invest_turnover():
    """Оборот по источникам. Приоритет — сводки стратегии из Telegram-канала
    (strategy_summary, за сегодня МСК); фолбэк — сделки счёта из API брокера.
    Результат кешируется в памяти на 90с — оборот дня меняется редко, а
    запрос идёт каждый тик баннера (60с) и не должен молотить БД."""
    resp = make_response(jsonify(_invest_turnover_payload()))
    resp.cache_control.no_store = True
    resp.cache_control.no_cache = True
    resp.cache_control.must_revalidate = True
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp


@app.route("/api/invest/report")
def api_invest_report():
    """Дневные строки отчёта: капитал нач/конец, изменение, объём, комиссия, ставка.
    Агрегация по интервалу и итоги периода — на клиенте."""
    period = request.args.get('period', '-90 day')
    data = cached_invest("report", INVEST_DB_PATH, {"period": period},
                         lambda: invest_repo.read_report(period, db_path=INVEST_DB_PATH))
    if isinstance(data, dict) and data.get("_error"):
        return jsonify({"error": data["_error"]}), data.get("_error_code", 500)
    resp = make_response(jsonify({"period": period, "days": data}))
    resp.cache_control.max_age = 180
    resp.cache_control.public = True
    return resp


@app.route("/api/invest/bot_events")
def api_invest_bot_events():
    """События бота из каналов стратегии (bot_events):
    классификация и сводка — на лету в invest_repo.read_bot_events."""
    period = request.args.get('period', '-35 day')
    data = cached_invest("bot_events", INVEST_DB_PATH, {"period": period},
                         lambda: invest_repo.read_bot_events(period, db_path=INVEST_DB_PATH))
    if isinstance(data, dict) and data.get("_error"):
        return jsonify({"error": data["_error"]}), data.get("_error_code", 500)
    resp = make_response(jsonify({"period": period, "events": data["events"], "summary": data["summary"]}))
    resp.cache_control.max_age = 180
    resp.cache_control.public = True
    return resp


@app.route("/api/invest/capital")
def api_invest_capital():
    """Размер и структура капитала: последний снимок по каждому источнику.
    {source: {ts, total, cash: {CUR:..}, positions: [{ticker, quantity, price, value}]}}"""
    data = cached_invest("capital", INVEST_DB_PATH, {},
                         lambda: invest_repo.read_capital_structure(db_path=INVEST_DB_PATH))
    if isinstance(data, dict) and data.get("_error"):
        return jsonify({"error": data["_error"]}), data.get("_error_code", 500)
    resp = make_response(jsonify(data))
    resp.cache_control.no_store = True
    resp.cache_control.no_cache = True
    resp.cache_control.must_revalidate = True
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp


# === API для тикеров (TGLD@) ===
TRACKED_TICKERS_DB_PATH = os.path.join(os.path.dirname(__file__), "parsers", "invest", "tracked_tickers.db")

@app.route("/api/invest/ticker/<ticker>")
def api_invest_ticker(ticker):
    if not os.path.exists(TRACKED_TICKERS_DB_PATH):
        return jsonify({"error": "Ticker DB not found"}), 404
    
    interval = request.args.get('interval', 'hour')
    period = request.args.get('period', '-28 day')
    bucket_size = {'minute': 60, 'fivemin': 300, 'twentymin': 1200, 'hour': 3600, 'sixhour': 21600, 'day': 86400}.get(interval, 3600)
    figi = {"TGLD@": "TCS80A101X50", "GDH6": "FUTGOLD03260", "XAU/USD": "XAU_USD"}.get(ticker.upper())
    if not figi:
        return jsonify({"error": "Ticker not found"}), 404

    def generate():
        rows = invest_repo.read_prices(period, figi=figi, db_path=TRACKED_TICKERS_DB_PATH)
        if not rows:
            rows = invest_repo.read_prices(None, figi=figi, db_path=TRACKED_TICKERS_DB_PATH)
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


def _ticker_baseline_points(db_path, figi, horizons):
    """Базовые цены тикера от ПОЛНОЙ истории (независимо от запрошенного range).
    horizons — список меток, для каждой возвращает {price, ts_epoch} = последняя цена
    до границы last_ts - H. Горизонт 'day' = старт последних суток."""
    import sqlite3 as _sq
    con = _sq.connect(db_path)
    con.row_factory = _sq.Row
    try:
        row = con.execute("SELECT MAX(ts_epoch) AS last_ts FROM last_prices WHERE figi=?", (figi,)).fetchone()
        if not row or row["last_ts"] is None:
            return None
        last_ts = row["last_ts"]
        out = {"last_ts": last_ts}
        for label, horizon in horizons.items():
            if horizon is None:
                ts = last_ts - (last_ts % 86400)
            else:
                ts = last_ts - int(horizon * 86400)
            r = con.execute(
                "SELECT price, ts_epoch FROM last_prices WHERE figi=? AND ts_epoch<=? ORDER BY ts_epoch DESC LIMIT 1",
                (figi, ts)).fetchone()
            out[label] = ({"price": round(r["price"], 2), "ts_epoch": r["ts_epoch"]} if r else None)
        return out
    finally:
        con.close()


@app.route("/api/invest/tickers")
def api_invest_tickers():
    interval = request.args.get('interval', 'hour')
    period = request.args.get('period', '-28 day')
    start_ts = _int_or_none(request.args.get('start_ts'))
    end_ts = _int_or_none(request.args.get('end_ts'))

    t0 = time.time()
    data = _invest_tickers_payload(interval, period, start_ts, end_ts)
    elapsed = int((time.time() - t0) * 1000)
    tkeys = len(data) if isinstance(data, dict) else 0
    print(f"[INVEST] tickers interval={interval} figis={tkeys} cache={os.path.exists(os.path.join(CACHE_DIR, invest_cache_key('tickers', interval=interval, period=period, start_ts=start_ts, end_ts=end_ts) + '.json'))} ms={elapsed}", flush=True)
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
# Запуск




# =========================================================================
# Медиатор данных — единый POST /api/data_mediator (эпик mediators)
# Существующие /api/* НЕ трогаем — они остаются fallback'ом для клиента.
# =========================================================================
def _read_battery_payload(db_path=DB_PATH, device_id=None, interval="hour",
                          period_param=None, limit=None):
    """GET-payload батареи (тот же SQL, что и GET-вeткa /api/battery).
    Возврат: list[dict] либо {"_error":…} — без jsonify."""
    import sqlite3

    if not device_id:
        return {"_error": "device_id_local required"}
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        period_map = {"day": "-56 day", "hour": "-14 day", "minute": "-2 day"}
        period = period_param if period_param else period_map.get(interval, "-14 day")
        limit_map = {"day": 5000, "hour": 3000, "minute": 600}
        limit = limit if limit is not None else limit_map.get(interval, 3000)

        cur.execute(f"""
            SELECT
                strftime('%Y-%m-%d %H:%M', datetime) AS minute_group,
                AVG(battery_level) AS avg_level
            FROM battery_logs
            WHERE device_id = ? AND datetime >= datetime('now', '{period}')
            GROUP BY (strftime('%s', datetime) / 600)
            ORDER BY minute_group DESC
            LIMIT ?
        """, (device_id, limit))
        rows = cur.fetchall()
        conn.close()
        return [{"datetime": r[0], "battery_level": r[1]} for r in rows]
    except Exception as e:
        return {"_error": str(e)}


def _write_battery_payload(db_path=DB_PATH, device_id=None, battery_level=None):
    """POST-payload батареи (тот же SQL, что и POST в /api/battery).
    Возврат: {"ok":True} либо {"_error":…} — без jsonify."""
    import sqlite3
    try:
        battery_level = int(battery_level)
        if not (0 <= battery_level <= 100):
            return {"_error": "value must be integer 0-100"}
    except (TypeError, ValueError):
        return {"_error": "value must be integer 0-100"}
    if not device_id:
        return {"_error": "device_id_local required"}
    try:
        conn = sqlite3.connect(db_path)
        conn.execute(
            "INSERT OR REPLACE INTO battery_logs (datetime, device_id, battery_level) "
            "VALUES (datetime('now'), ?, ?)", (device_id, battery_level))
        conn.commit()
        conn.close()
        return {"ok": True}
    except Exception as e:
        return {"_error": str(e)}


# ---- Invest payload-хелперы медиатора (общие с /api/invest/*) ----
def _invest_history_payload(interval="hour", period="-30 day", start_ts=None,
                            end_ts=None, after_ts=None):
    """Полный payload истории капитала (тот же путь, что GET /api/invest/history)."""
    # 'live' (и любые не-числа) из медиатор-параметров → None, как в GET-пути
    # (_int_or_none на линии запроса) и как у секции tickers: иначе read_history
    # падает int('live') (ValueError), секция приходит {"_error": ...} и затирает
    # историю/баннер на клиенте. 'live' = «до текущего момента» = end_ts None.
    start_ts = _int_or_none(start_ts)
    end_ts = _int_or_none(end_ts)
    bucket_size = {'minute': 60, 'fivemin': 300, 'twentymin': 1200, 'hour': 3600,
                   'sixhour': 21600, 'day': 86400}.get(interval, 3600)
    base = {"interval": interval, "period": period, "start_ts": start_ts, "end_ts": end_ts}
    if after_ts is not None:
        return invest_repo.read_history(period, bucket_size, db_path=INVEST_DB_PATH,
                                        start_epoch=start_ts, end_epoch=end_ts,
                                        after_ts=after_ts)
    return cached_invest("history", INVEST_DB_PATH, base,
                         lambda: invest_repo.read_history(period, bucket_size, db_path=INVEST_DB_PATH,
                                                          start_epoch=start_ts, end_epoch=end_ts),
                         ttl=30)


def _invest_tickers_payload(interval="hour", period="-28 day", start_ts=None, end_ts=None):
    """Полный payload тикеров (тот же путь, что GET /api/invest/tickers)."""
    # 'live' (и любые не-числа) из медиатор-параметров → None, как в GET-пути
    # (_int_or_none на линии запроса). Конвертация ДО generate(): внутри генератора
    # присваивание затенило бы closure (UnboundLocalError). Иначе секция падает
    # ValueError и приходит {"_error": ...}, затирая тикеры на клиенте.
    start_ts = _int_or_none(start_ts)
    end_ts = _int_or_none(end_ts)
    bucket_size = {'minute': 60, 'fivemin': 300, 'twentymin': 1200, 'hour': 3600,
                   'sixhour': 21600, 'day': 86400}.get(interval, 3600)

    def generate():
        if not os.path.exists(TRACKED_TICKERS_DB_PATH):
            return {"_error": "Ticker DB not found", "_error_code": 404}
        rows = invest_repo.read_prices(period, db_path=TRACKED_TICKERS_DB_PATH,
                                       start_epoch=start_ts, end_epoch=end_ts)
        # Фолбэк на полный диапазон только когда явный from/to НЕ задан,
        # чтобы тикеры не выходили за границы диапазона портфеля.
        if not rows and start_ts is None and end_ts is None:
            rows = invest_repo.read_prices(None, db_path=TRACKED_TICKERS_DB_PATH)

        ticker_groups = {}
        for r in rows:
            figi = r["figi"]
            if figi not in ticker_groups:
                ticker_groups[figi] = {"ticker": r["ticker"] or figi,
                                       "class_code": r["class_code"], "prices": {}}
            dt = datetime.fromisoformat(r["timestamp"].replace('Z', '+00:00'))
            bucket_key = str(int(dt.timestamp() / bucket_size) * bucket_size)
            ticker_groups[figi]["prices"][bucket_key] = {
                "timestamp": r["timestamp"], "price": round(r["price"], 2)}

        result = {}
        MAX_TICKER_POINTS = 3000
        for figi, group in ticker_groups.items():
            prices = [group["prices"][k] for k in sorted(group["prices"].keys())]
            if not prices:
                continue
            if len(prices) > MAX_TICKER_POINTS:
                step = max(1, (len(prices) + MAX_TICKER_POINTS - 1) // MAX_TICKER_POINTS)
                decimated = [prices[i] for i in range(0, len(prices), step)]
                if decimated[-1] != prices[-1]:
                    decimated.append(prices[-1])
                prices = decimated
            cp = prices[-1]["price"]

            bl = _ticker_baseline_points(TRACKED_TICKERS_DB_PATH, figi,
                                         {"day": None, "week": 7, "month": 30})

            def _pct_from_base(base):
                if not base or not base.get("price") or base["price"] <= 0:
                    return None, None
                ch = cp - base["price"]
                return round(ch, 2), round(ch / base["price"] * 100, 2)

            dy_abs, dy_pct = _pct_from_base(bl["day"] if bl else None)
            wk_abs, wk_pct = _pct_from_base(bl["week"] if bl else None)
            mo_abs, mo_pct = _pct_from_base(bl["month"] if bl else None)

            result[group["ticker"]] = {
                "figi": figi, "current_price": cp,
                "day_change": dy_abs, "day_change_pct": dy_pct,
                "week_change": wk_abs, "week_change_pct": wk_pct,
                "month_change": mo_abs, "month_change_pct": mo_pct,
                "baseline": bl,
                "prices": prices
            }
        return result

    return cached_invest("tickers", TRACKED_TICKERS_DB_PATH,
                         {"interval": interval, "period": period,
                          "start_ts": start_ts, "end_ts": end_ts}, generate,
                         ttl=30)


def _invest_turnover_payload():
    """Оборот по источникам (кеш 90с) — общий для /api/invest/turnover и медиатора."""
    now = time.time()
    ttl = 90
    hit = _turnover_cache.get("data", None)
    if hit is not None and (now - _turnover_cache.get("at", 0)) < ttl:
        return hit

    import sqlite3
    now_msk = datetime.now(timezone.utc) + timedelta(hours=3)
    today = now_msk.strftime("%Y-%m-%d")
    out = {}
    try:
        con = sqlite3.connect(INVEST_DB_PATH)
        con.row_factory = sqlite3.Row
        rows = con.execute(
            "SELECT source, capital, turnover FROM strategy_summary"
            " WHERE day=? ORDER BY id DESC", (today,)).fetchall()
        seen = set()
        for r in rows:
            if r["source"] in seen:
                continue
            seen.add(r["source"])
            total = r["turnover"] or 0
            # Комиссия: Тинвест — 0,02% от оборота; Финам — тариф «Трейдер n6»
            # (брекетная ставка МосБиржи; стратегия торгует TGLD на MOEX)
            if r["source"] == "tinkoff":
                comm = round(total * 0.0002, 2)
            elif r["source"] == "finam":
                # Стратегия Финам торгует на СПБ Бирже:
                # брекетная ставка + урегулирование СПБ 0,01%
                comm = round(invest_repo.finam_commission_estimate(0, total), 2)
            else:
                comm = None
            out[r["source"]] = {
                "total": total,
                "buy": 0, "sell": 0,
                "commission": comm,
                "capital": r["capital"],
                "strategy": True,
            }
        con.close()
    except sqlite3.Error:
        pass
    # Фолбэк: все сделки счёта с начала суток (UTC-полночь)
    missing = {"tinkoff", "finam"} - set(out)
    if missing:
        since = int(datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0).timestamp())
        for src, d in invest_repo.read_turnover_since(since, db_path=INVEST_DB_PATH).items():
            if src in missing:
                total_fb = d.get("total", 0)
                if src == "finam":
                    d["commission"] = round(invest_repo.finam_commission_estimate(0, total_fb), 2)
                elif src == "tinkoff":
                    d["commission"] = round(total_fb * 0.0002, 2)
                d["strategy"] = False
                out[src] = d

    _turnover_cache["data"] = out
    _turnover_cache["at"] = now
    return out


def _invest_turnover_details_payload():
    """Детализация оборота за сегодня: total/капитал из strategy_summary +
    база/ставка/комиссия/поручения из tariff_details (P2: демон парсит
    сообщение «Тариф процентный» один раз при приходе и кладёт JSON).
    Regex из 5с-цикла исключён (минус parse и import re)."""
    now_msk = datetime.now(timezone.utc) + timedelta(hours=3)
    today = now_msk.strftime("%Y-%m-%d")
    out = {}
    try:
        con = sqlite3.connect(INVEST_DB_PATH)
        con.row_factory = sqlite3.Row
        for src in ("finam", "tinkoff"):
            d = {"day": today, "turnover": None, "capital": None, "commission": None,
                 "base": None, "session": None, "evening": None, "orders": None,
                 "rate_percent": None, "fee_per_order": None, "strategy": False}
            row = con.execute(
                "SELECT capital, turnover, commission FROM strategy_summary"
                " WHERE source=? AND day=? ORDER BY id DESC LIMIT 1",
                (src, today)).fetchone()
            if row:
                d["strategy"] = True
                d["turnover"] = row["turnover"]
                d["capital"] = row["capital"]
                d["commission"] = row["commission"]
            # JSON-детали «Тариф процентный» от демона (P2, tariff_details).
            # Таблицы может ещё не быть (демон не перезапущен) — тогда только
            # базовые turnover/capital/commission из strategy_summary.
            try:
                tr = con.execute(
                    "SELECT payload_json FROM tariff_details"
                    " WHERE day=? AND source=?", (today, src)).fetchone()
            except sqlite3.Error:
                tr = None
            if tr and tr["payload_json"]:
                try:
                    t = json.loads(tr["payload_json"])
                except (ValueError, TypeError):
                    t = None
                if t:
                    for k in ("commission", "base", "session", "evening",
                              "orders", "rate_percent", "fee_per_order"):
                        if t.get(k) is not None:
                            d[k] = t[k]
            out[src] = d
        con.close()
    except sqlite3.Error:
        pass
    return out


# === Движок медиатора (единый, panel_mediator.py) ===
# Токены секций: SHA-256 fingerprint payload (sort_keys); исключение —
# invest.history — его «токен» = _latest_epoch (дельта-навигация хвоста),
# а после_ts клиент шлёт явно в params (P6), цифровой токен — fallback (BC).

class _WClockMediator(PanelMediator):
    """WClock-подкласс: tail-логика секции invest.history поверх движка."""

    def prepare_params(self, sect, client_tok, params, ctx):
        params = dict(params or {})
        if sect == "invest.history":
            after = params.get("after_ts")
            if after is None and client_tok and str(client_tok).isdigit() \
                    and int(client_tok) > 0:
                # BC: старый клиент кодирует эпоху в цифровом токене.
                after = int(client_tok)
            if after is not None:
                params["after_ts"] = after
                ctx["tail"] = True
        return params

    def post_read(self, sect, payload, ctx):
        if ctx.get("tail") and isinstance(payload, dict) \
                and not payload.get("_error"):
            payload["_tail"] = True
        return payload

    def section_token(self, sect, payload):
        if sect == "invest.history" and isinstance(payload, dict) \
                and payload.get("_latest_epoch") is not None:
            return str(payload["_latest_epoch"])
        return stable_token(payload)


# Карта reader'ов секций медиатора (чистые payload без jsonify).
_DATA_MEDIATOR_READERS = {
    "weather": lambda p: get_weather(),
    "charts_data": lambda p: _read_charts_payload(db_path=DB_PATH),
    "battery.history": lambda p: _read_battery_payload(
        db_path=DB_PATH,
        device_id=p.get("device_id") if isinstance(p, dict) else None,
        interval=(p or {}).get("interval", "hour"),
        period_param=(p or {}).get("period"),
        limit=(p or {}).get("limit")),
    "invest.history": lambda p: _invest_history_payload(
        interval=(p or {}).get("interval", "hour"),
        period=(p or {}).get("period", "-30 day"),
        start_ts=(p or {}).get("start_ts"),
        end_ts=(p or {}).get("end_ts"),
        after_ts=(p or {}).get("after_ts")),
    "invest.tickers": lambda p: _invest_tickers_payload(
        interval=(p or {}).get("interval", "hour"),
        period=(p or {}).get("period", "-28 day"),
        start_ts=(p or {}).get("start_ts"),
        end_ts=(p or {}).get("end_ts")),
    "invest.turnover": lambda p: _invest_turnover_payload(),
    "invest.turnover_details": lambda p: _invest_turnover_details_payload(),
    "settings": lambda p: get_settings(),
}

# Карта writer'ов (battery) + интервалы записи (сек).
_DATA_MEDIATOR_WRITERS = {
    "battery": lambda p: _write_battery_payload(
        db_path=DB_PATH,
        device_id=(p or {}).get("device_id"),
        battery_level=(p or {}).get("value")),
}
_DATA_MEDIATOR_WRITE_INTERVAL = {"battery": 60}

# Единый инстанс медиатора (подкласс с tail-логикой invest.history).
_DATA_MEDIATOR = _WClockMediator(
    readers=_DATA_MEDIATOR_READERS,
    writers=_DATA_MEDIATOR_WRITERS,
    write_interval=_DATA_MEDIATOR_WRITE_INTERVAL,
)


@app.route("/api/data_mediator", methods=["POST"])
def api_data_mediator():
    """Единый медиатор данных: дельта по секциям через токены.
    Движок — panel_mediator.PanelMediator (единый, тестируемый).
    """
    body = request.get_json(silent=True) or {}
    # Контракт: пустой слой v = клиент «с нуля» → вернуть ВСЕ известные
    # секции (client-токен «неизвестен» = пустая строка). write/params
    # из исходного body сохраняются.
    if not body.get("v"):
        body = {
            "v": {sect: "" for sect in _DATA_MEDIATOR_READERS},
            "params": body.get("params") or {},
            "write": body.get("write") or {},
        }
    res = _DATA_MEDIATOR.process(body)
    res["ts"] = (datetime.now(timezone.utc) + timedelta(hours=3)).strftime(
        "%Y-%m-%d %H:%M:%S")
    return jsonify(res)



if __name__ == "__main__":
    print("🚀 Запуск сервера Flask...")
    PORT = int(os.environ.get("PORT", "5001")) 
    print(f"🌐 Порт: {PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)