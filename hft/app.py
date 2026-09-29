# app.py — HFT мониторинг + CRM (отдельный сервис hft.startupassist.ru)
# Переиспользует invest_repo.py и invest_portfolio.db из wclock5 (read-only).
import os
import sys
import json
import time as _time
from datetime import datetime, timezone
from functools import wraps

from flask import Flask, jsonify, render_template, request, make_response, abort

HERE = os.path.dirname(__file__)
WCLOCK_REPO = os.environ.get("WCLOCK_REPO", "/app/wclock_repo")
sys.path.insert(0, WCLOCK_REPO)

import crm_db
import invest_repo

app = Flask(__name__,
            template_folder=os.path.join(HERE, "templates"),
            static_folder=os.path.join(HERE, "static"),
            static_url_path="/static")
app.secret_key = os.environ.get("HFT_SECRET_KEY", "hft-dev-secret")

INVEST_DB = os.path.join(WCLOCK_REPO, "parsers", "invest", "invest_portfolio.db")
TICKERS_DB = os.path.join(WCLOCK_REPO, "parsers", "invest", "tracked_tickers.db")

crm_db.init_db()


@app.after_request
def add_no_cache(response):
    if request.path.startswith("/static/") or response.mimetype == "text/html":
        response.cache_control.no_cache = True
        response.cache_control.no_store = True
        response.cache_control.must_revalidate = True
    return response


def conn_crm():
    return crm_db.connect()


def token_from_request():
    return request.cookies.get("hft_session")


def error(msg, code=400):
    return jsonify({"ok": False, "error": msg}), code


def _int_or_none(v):
    """start_ts/end_ts из query — int либо None."""
    if v is None:
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def require_login(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        with conn_crm() as c:
            user = crm_db.session_user(c, token_from_request())
        if not user:
            return error("Требуется авторизация", 401)
        return fn(user, *args, **kwargs)
    return wrapper


def require_panel(panel):
    def deco(fn):
        @wraps(fn)
        def wrapper(user, *args, **kwargs):
            if user["role"] != "admin" and panel not in user["panels"]:
                return error("Нет доступа к панели", 403)
            return fn(user, *args, **kwargs)
        return wrapper
    return deco


def read_ts(word):
    ts = datetime.now(timezone.utc).timestamp()
    return ts - int(word)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "ts": _time.time()})


# ─── Auth ─────────────────────────────────────────────────────────────
@app.route("/api/auth/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    with conn_crm() as c:
        res = crm_db.auth(c, username, password)
    if not res:
        return error("Неверный логин или пароль", 401)
    token, user = res
    resp = make_response(jsonify({"ok": True, "user": user}))
    resp.set_cookie("hft_session", token, max_age=7 * 86400,
                    httponly=True, samesite="Lax", secure=request.is_secure)
    return resp


@app.route("/api/auth/logout", methods=["POST"])
def logout():
    with conn_crm() as c:
        crm_db.logout(c, token_from_request())
    resp = make_response(jsonify({"ok": True}))
    resp.delete_cookie("hft_session")
    return resp


@app.route("/api/auth/me")
def me():
    with conn_crm() as c:
        user = crm_db.session_user(c, token_from_request())
    if not user:
        return error("Требуется авторизация", 401)
    return jsonify({"ok": True, "user": user})


# ─── CRM (admin) ──────────────────────────────────────────────────────
@app.route("/api/crm/users", methods=["GET"])
@require_login
def crm_users(user):
    if user["role"] != "admin":
        return error("Только админ", 403)
    with conn_crm() as c:
        users = crm_db.list_users(c)
    return jsonify({"ok": True, "users": users})


@app.route("/api/crm/users", methods=["POST"])
@require_login
def crm_user_create(user):
    if user["role"] != "admin":
        return error("Только админ", 403)
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    if not username or len(password) < 6:
        return error("username и пароль (≥6 символов) обязательны")
    panels = data.get("panels") or []
    with conn_crm() as c:
        if crm_db.get_user_by_name(c, username):
            return error("Пользователь существует")
        uid = crm_db.create_user(c, username, password,
                                 role=data.get("role", "user"),
                                 panels=panels,
                                 tg=data.get("tg", ""))
        u = crm_db.get_user(c, uid)
    return jsonify({"ok": True, "user": u})


@app.route("/api/crm/users/<int:uid>", methods=["PUT"])
@require_login
def crm_user_update(user, uid):
    if user["role"] != "admin":
        return error("Только админ", 403)
    data = request.get_json(silent=True) or {}
    with conn_crm() as c:
        if uid == user["id"] and data.get("role") != "admin":
            return error("Нельзя понизить себя")
        u = crm_db.update_user(c, uid,
                               password=data.get("password"),
                               role=data.get("role"),
                               panels=data.get("panels"),
                               tg=data.get("tg"))
        if not u:
            return error("Пользователь не найден", 404)
    return jsonify({"ok": True, "user": u})


@app.route("/api/crm/users/<int:uid>", methods=["DELETE"])
@require_login
def crm_user_delete(user, uid):
    if user["role"] != "admin":
        return error("Только админ", 403)
    with conn_crm() as c:
        if uid == user["id"]:
            return error("Нельзя удалить себя")
        c.execute("DELETE FROM panel_access WHERE user_id=?", (uid,))
        c.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        c.execute("DELETE FROM users WHERE id=?", (uid,))
        c.commit()
    return jsonify({"ok": True})


@app.route("/api/crm/meta")
@require_login
def crm_meta(user):
    if user["role"] != "admin":
        return error("Только админ", 403)
    return jsonify({"ok": True, "panels": crm_db.PANELS})


# ─── HFT-панели (данные из wclock5 invest DB) ────────────────────────
@app.route("/api/hft/capital")
@require_login
@require_panel("capital")
def hft_capital(user):
    try:
        struct = invest_repo.read_capital_structure(db_path=INVEST_DB)
    except Exception as e:
        return error(f"invest_repo: {e}", 500)
    # только самые свежие снапшоты по источникам
    out = {}
    for src, snap in struct.items():
        if snap and snap.get("ts"):
            out[src] = {"ts": snap["ts"], "total": snap["total"],
                        "cash": snap.get("cash", {}), "positions": snap.get("positions", [])}
    return jsonify({"ok": True, "capital": out, "ts": _time.time()})


@app.route("/api/hft/turnover")
@require_login
@require_panel("turnover")
def hft_turnover(user):
    days = request.args.get("days", default=14, type=int)
    days = min(max(days, 1), 90)
    try:
        rows = invest_repo.read_turnover(days=days, db_path=INVEST_DB)
    except Exception as e:
        return error(f"invest_repo: {e}", 500)
    out = {}
    for r in rows:
        day, src = r["day"], r["source"]
        out.setdefault(day, {})[src] = {"buy": r.get("buy", 0), "sell": r.get("sell", 0),
                                        "commission": r.get("commission", 0), "count": r.get("count", 0)}
    return jsonify({"ok": True, "days": out, "ts": _time.time()})


@app.route("/api/hft/feed")
@require_login
@require_panel("feed")
def hft_feed(user):
    hours = request.args.get("hours", default=24, type=int)
    ts = datetime.now(timezone.utc).timestamp() - hours * 3600
    try:
        data = invest_repo.read_bot_events(period="-24 hour", db_path=INVEST_DB)
    except Exception as e:
        return error(f"invest_repo: {e}", 500)
    events = ([e for e in data.get("events", []) if e.get("ts", 0) >= ts])[-200:]
    summary = data.get("summary", {})
    return jsonify({"ok": True, "events": events, "summary": summary, "ts": _time.time()})


@app.route("/api/hft/tickers")
@require_login
@require_panel("tickers")
def hft_tickers(user):
    try:
        prices = invest_repo.read_prices(period="-120 day", db_path=TICKERS_DB)
    except Exception as e:
        return error(f"invest_repo: {e}", 500)
    out = {}
    for p in prices:
        # read_prices без figi → кортежи (figi, ticker, class_code, timestamp, price)
        figi, ticker = p[0], p[1]
        key = ticker or figi
        if key not in out:
            out[key] = {"ticker": ticker or figi, "last": p[4],
                        "ts": p[3]}
    return jsonify({"ok": True, "tickers": list(out.values()), "ts": _time.time()})


@app.route("/api/hft/history")
@require_login
@require_panel("chart")
def hft_history(user):
    """Данные портфеля для графика (read_history из invest_repo), как /api/invest/history."""
    interval = request.args.get("interval", "hour")
    period = request.args.get("period", "-35 day")
    start_ts = _int_or_none(request.args.get("start_ts"))
    end_ts = _int_or_none(request.args.get("end_ts"))
    bucket_size = {"minute": 60, "fivemin": 300, "twentymin": 1200,
                   "hour": 3600, "sixhour": 21600, "day": 86400}.get(interval, 3600)
    try:
        data = invest_repo.read_history(period, bucket_size, db_path=INVEST_DB, start_epoch=start_ts, end_epoch=end_ts)
    except Exception as e:
        return error(f"invest_repo: {e}", 500)
    return jsonify(data)


@app.route("/api/hft/chart_tickers")
@require_login
@require_panel("chart")
def hft_chart_tickers(user):
    """Котировки тикеров графика (read_prices из invest_repo), как /api/invest/tickers."""
    interval = request.args.get("interval", "hour")
    period = request.args.get("period", "-35 day")
    start_ts = _int_or_none(request.args.get("start_ts"))
    end_ts = _int_or_none(request.args.get("end_ts"))
    bucket_size = {"minute": 60, "fivemin": 300, "twentymin": 1200,
                   "hour": 3600, "sixhour": 21600, "day": 86400}.get(interval, 3600)
    try:
        rows = invest_repo.read_prices(period, db_path=TICKERS_DB, start_epoch=start_ts, end_epoch=end_ts)
    except Exception as e:
        return error(f"invest_repo: {e}", 500)
    if not rows:
        rows = invest_repo.read_prices(None, db_path=TICKERS_DB)

    ticker_groups = {}
    for r in rows:
        figi = r[0]
        ticker = r[1]
        if figi not in ticker_groups:
            ticker_groups[figi] = {"ticker": ticker or figi, "class_code": r[2], "prices": {}}
        dt = datetime.fromisoformat(r[3].replace('Z', '+00:00'))
        bucket_key = str(int(dt.timestamp() / bucket_size) * bucket_size)
        ticker_groups[figi]["prices"][bucket_key] = {"timestamp": r[3], "price": round(r[4], 2)}

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
        result[group["ticker"]] = {
            "figi": figi, "current_price": prices[-1]["price"],
            "prices": prices
        }
    return jsonify(result)


@app.route("/api/hft/report")
@require_login
@require_panel("report")
def hft_report(user):
    """Дневные строки отчёта по портфелю (read_report из invest_repo).
    Агрегация по интервалу и итоги периода — на клиенте, как в wclock."""
    period = request.args.get("period", "-35 day")
    try:
        days = invest_repo.read_report(period, db_path=INVEST_DB)
    except Exception as e:
        return error(f"invest_repo: {e}", 500)
    return jsonify({"ok": True, "period": period, "days": days, "ts": _time.time()})


@app.route("/api/hft/bot_events")
@require_login
@require_panel("report")
def hft_bot_events(user):
    """События бота из каналов стратегии (read_bot_events из invest_repo)."""
    period = request.args.get("period", "-35 day")
    try:
        data = invest_repo.read_bot_events(period, db_path=INVEST_DB)
    except Exception as e:
        return error(f"invest_repo: {e}", 500)
    return jsonify({"ok": True, "period": period,
                    "events": data.get("events", []),
                    "summary": data.get("summary", {})})


# ── погода (порт wclock /api/weather, /api/charts_data — mail.ru odintsovo_weather.db) ──
WEATHER_DB = os.path.join(WCLOCK_REPO, "parsers", "mail.ru", "odintsovo_weather.db")


def _weather_conn():
    import sqlite3
    conn = sqlite3.connect(WEATHER_DB)
    conn.row_factory = sqlite3.Row
    return conn


@app.route("/api/hft/weather")
@require_login
def hft_weather(user):
    """Последний факт погоды и краткий прогноз (как wclock /api/weather)."""
    if not os.path.exists(WEATHER_DB):
        return error("weather DB не найден", 500)
    conn = _weather_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM current ORDER BY collected_at DESC LIMIT 1")
        current = cur.fetchone()
        fact = dict(current) if current else {}

        cur.execute("SELECT * FROM hourly_forecast ORDER BY collected_at DESC LIMIT 12")
        forecast_rows = cur.fetchall()
        if forecast_rows:
            short_range = dict(forecast_rows[0])
            long_range = dict(forecast_rows[-1])
            for k, v in short_range.items():
                if k not in fact:
                    fact[k] = v
            forecast_summary = {"parts": [dict(long_range)]}
        else:
            forecast_summary = {"parts": [], "sunrise": "", "sunset": "", "moon_code": 0}
    except Exception as e:
        conn.close()
        return error(f"weather: {e}", 500)
    conn.close()
    return jsonify({"ok": True, "fact": fact, "forecast_summary": forecast_summary})


@app.route("/api/hft/charts_data")
@require_login
def hft_charts_data(user):
    """Таймлайн погоды для графика (как wclock /api/charts_data)."""
    if not os.path.exists(WEATHER_DB):
        return error("weather DB не найден", 500)
    conn = _weather_conn()
    try:
        cur = conn.cursor()
        cur.execute("""
        WITH last_update AS (
            SELECT MAX(collected_at) AS last_time FROM hourly_forecast
        ),
        base AS (
            SELECT
                datetime(time) AS datetime,
                temperature, humidity, pressure, precip_prob, wind_speed, feels_like
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
        """)
        rows = cur.fetchall()
        data = [dict(row) for row in rows]
    except Exception as e:
        conn.close()
        return error(f"charts_data: {e}", 500)
    conn.close()
    return jsonify({"ok": True, "rows": data})


@app.route("/api/hft/layout", methods=["GET", "PUT"])
@require_login
def hft_layout(user):
    """Раскладка панелей пользователя (позиции/размеры/видимость)."""
    with conn_crm() as c:
        if request.method == "GET":
            return jsonify({"ok": True, "layout": crm_db.get_layout(c, user["id"])})
        data = (request.get_json(silent=True) or {}).get("layout")
        if not data or not isinstance(data, str):
            return error("layout (JSON-строка) обязателен")
        try:
            json.loads(data)
        except ValueError:
            return error("layout должен быть валидным JSON")
        crm_db.set_layout(c, user["id"], data)
    return jsonify({"ok": True})


# ── Аналитика рынка (arbitrage.db из 54.Hft → MOEX ISS) ────────────────
from analytics_api import bp as analytics_bp
import analytics_db  # noqa: F401  (модуль используется внутри blueprint)
app.register_blueprint(analytics_bp)

# Новостной конвейер: создаёт news.db (sources/articles/scores) при старте
import news_db  # noqa: E402
try:
    news_db.init_db()
except Exception as _e:
    print(f"[warn] news_db init failed: {_e}")


@app.route("/analytics")
def analytics_page():
    """Страница аналитики рынка. Без сессии JS показывает форму логина (без редиректа)."""
    return render_template("analytics.html")


_NEWS_MIN = int(os.environ.get("NEWS_COLLECT_MIN", "45"))
_NEWS_WORKER = None
_NEWS_LOCK = None


def _news_tick():
    """Один проход сбора новостей с health-check и retry."""
    import news_collector
    import news_db as _nd
    try:
        _nd.init_db()
        total_found = 0
        total_relevant = 0
        total_added = 0
        total_errors = 0
        sources_detail = {}
        now_str = datetime.now().strftime("%H:%M")
        active = ("googlenews", "oilprice", "investing", "fomc", "tass", "cnbc", "marketwatch")
        for code in active:
            try:
                conn = _nd.news_conn()
                r = news_collector.import_articles(conn, code, None, max_items=40)
                total_found += r["found"]
                total_relevant += r["relevant"]
                total_added += r["added"]
                sources_detail[code] = r
            except Exception as _e:
                total_errors += 1
                sources_detail[code] = {"found": 0, "relevant": 0, "added": 0, "error": str(_e)[:200]}
                print(f"[news] {code}: {_e}")
        news_collector._record_stats("tick", total_added, total_errors)
        news_collector._record_run(now_str, total_found, total_relevant, total_added, total_errors, sources_detail)
        print(f"[news] сбор завершён: найдено {total_found}, релевантных {total_relevant}, добавлено {total_added}, ошибок {total_errors}")
    except Exception as _e:
        print(f"[news] проход сбора упал: {_e}")


def _start_news_worker():
    """Фоновый поток: сбор новостей каждые NEWS_COLLECT_MIN минут с lock."""
    global _NEWS_WORKER, _NEWS_LOCK
    if int(os.environ.get("NEWS_WORKER", "1")) != 1:
        return
    import threading
    _NEWS_LOCK = threading.Lock()

    def loop():
        while True:
            try:
                if _NEWS_LOCK.acquire(blocking=False):
                    try:
                        _news_tick()
                    finally:
                        _NEWS_LOCK.release()
            except Exception as _e:
                print(f"[news] worker error: {_e}")
            _time.sleep(_NEWS_MIN * 60)

    th = threading.Thread(target=loop, name="news-worker", daemon=True)
    th.start()
    _NEWS_WORKER = th
    print(f"[news] фоновый сбор каждые {_NEWS_MIN} мин")


if __name__ == "__main__":
    _start_news_worker()
    port = int(os.environ.get("HFT_PORT", 5001))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("HFT_DEBUG") == "1")