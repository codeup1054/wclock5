# analytics_db.py — чтение arbitrage.db (54.Hft → hft-app) для аналитики.
# БД подмонтируется в контейнер read-only-совместимо (SQLite, только SELECT).
import os
import sqlite3
import time
from datetime import datetime


def analytics_conn():
    p = os.environ.get("ANALYTICS_DB", "")
    if not p:
        p = os.path.join(os.path.dirname(__file__), "analytics", "arbitrage.db")
    if not os.path.exists(p):
        raise FileNotFoundError(f"arbitrage.db не найден: {p}")
    conn = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def list_families(con):
    rows = con.execute(
        "SELECT family, asset_class, COUNT(*) AS n FROM instruments GROUP BY family ORDER BY family"
    ).fetchall()
    return [dict(r) for r in rows]


def list_instruments(con, family=None):
    if family:
        rows = con.execute(
            "SELECT secid, family, asset_class, type, name, board, last_trade_date "
            "FROM instruments WHERE family=? ORDER BY last_trade_date", (family,)).fetchall()
    else:
        rows = con.execute(
            "SELECT secid, family, asset_class, type, name, board, last_trade_date "
            "FROM instruments ORDER BY family, type, last_trade_date").fetchall()
    return [dict(r) for r in rows]


def read_candles(con, interval="1d", asset=None, limit=0, offset=0):
    """Свечи: по asset (family или secid). Если asset — family, отдаём непрерывный
    ряд (continuous) для дневного интервала, иначе — прямые контракты."""
    limit = int(limit) if limit else 0
    if interval == "1d":
        # continuous строится только на 1d
        rows = con.execute(
            "SELECT c.dt AS time, c.open, c.high, c.low, c.close, c.volume, c.secid "
            "FROM continuous c WHERE c.family=? ORDER BY c.dt DESC LIMIT ?",
            (asset, limit)).fetchall() if limit else con.execute(
            "SELECT c.dt AS time, c.open, c.high, c.low, c.close, c.volume, c.secid "
            "FROM continuous c WHERE c.family=? ORDER BY c.dt", (asset,)).fetchall()
        if limit:
            rows = list(reversed(rows))
        return [dict(r) for r in rows], None
    else:
        # более мелкие интервалы: активный фронт-контракт (мин. экспирация ≥ сегодня)
        inst = con.execute(
            "SELECT i.id, i.name, i.secid FROM instruments i "
            "WHERE i.family=? AND i.last_trade_date >= date('now') "
            "ORDER BY i.last_trade_date ASC, i.id ASC LIMIT 1",
            (asset,)).fetchone()
        if not inst:
            inst = con.execute(
                "SELECT i.id, i.name, i.secid FROM instruments i "
                "WHERE i.family=? ORDER BY i.last_trade_date DESC, i.id DESC LIMIT 1",
                (asset,)).fetchone()
        if not inst:
            return [], None
        conn2 = con
        q = ("SELECT c.time, c.open, c.high, c.low, c.close, c.volume "
             "FROM candles c WHERE c.instrument_id=? AND c.interval=? "
             "ORDER BY c.time")
        args = (inst["id"], interval)
        if limit:
            q += " DESC LIMIT ?" if limit else ""
            if limit:
                rows = conn2.execute(q, args + (limit,)).fetchall()
                rows = list(reversed(rows))
        else:
            rows = conn2.execute(q, args).fetchall()
        inst = dict(inst)
        return [dict(r) for r in rows], inst


def dataset_summary(con):
    """Сводка скачанных данных для таблицы «поиск пар»: семейства, инструменты,
    объём и диапазон по каждому интервалу (1d/60min/10min), continuous."""
    fam_rows = con.execute(
        "SELECT family, asset_class, COUNT(*) AS n_instr, "
        "       SUM(CASE WHEN type='futures' THEN 1 ELSE 0 END) AS n_fut "
        "FROM instruments GROUP BY family ORDER BY family").fetchall()
    families = []
    for r in fam_rows:
        families.append({"family": r["family"], "asset_class": r["asset_class"],
                         "instruments": r["n_instr"], "futures": r["n_fut"]})

    cand_rows = con.execute(
        "SELECT i.family, c.interval, COUNT(*) AS n, MIN(c.time) AS t0, MAX(c.time) AS t1 "
        "FROM candles c JOIN instruments i ON i.id = c.instrument_id "
        "GROUP BY i.family, c.interval ORDER BY i.family, c.interval").fetchall()
    candles = {}
    for r in cand_rows:
        candles.setdefault(r["family"], {})[r["interval"]] = {
            "n": r["n"], "t0": r["t0"], "t1": r["t1"]
        }

    cont_rows = con.execute(
        "SELECT family, COUNT(*) AS n, MIN(dt) AS t0, MAX(dt) AS t1 "
        "FROM continuous GROUP BY family ORDER BY family").fetchall()
    continuous = {r["family"]: {"n": r["n"], "t0": r["t0"], "t1": r["t1"]}
                  for r in cont_rows}

    return {"families": families, "candles": candles, "continuous": continuous}


def read_series_for_pair(con, interval="1d", limit=0):
    """Непрерывные ряды по парам «металл — энергия» (1d): обе ветки по датам."""
    out = {}
    if interval != "1d":
        return out
    rows = con.execute(
        "SELECT family, dt, close FROM continuous WHERE family IN "
        "('GOLD','SILV','COPPER','PLATINUM','BRENT','NGAS') ORDER BY family, dt").fetchall()
    for r in rows:
        out.setdefault(r["family"], []).append({"t": r["dt"], "c": r["close"]})
    if limit:
        for fam in out:
            out[fam] = out[fam][-int(limit):]
    return out


# ── ML: корреляционные матрицы со сдвигом по времени ──────────────────

ML_FAMILIES = ["GOLD", "SILV", "COPPER", "PLATINUM", "BRENT", "NGAS",
               "GOLD_SPOT", "PLATINUM_SPOT", "SILV_SPOT"]

# (interval) → доступные лаги (в барах интервала)
LAG_PRESETS = {
    "1d": [1, 2, 3, 5, 10, 20],
    "60min": [1, 2, 4, 12, 24, 48, 72, 144],
    "10min": [1, 3, 6, 12, 36, 72, 144, 288, 432],
}


def _family_series(con, interval):
    """Ряды закрытий по семьям: 1d → continuous; иначе активный фронт-контракт."""
    fams = [r[0] for r in con.execute(
        "SELECT DISTINCT family FROM instruments WHERE family IN "
        "('GOLD','SILV','COPPER','PLATINUM','BRENT','NGAS',"
        "'GOLD_SPOT','PLATINUM_SPOT','SILV_SPOT')").fetchall()]
    out = {}
    if interval == "1d":
        rows = con.execute(
            "SELECT family, dt, close, volume FROM continuous ORDER BY family, dt").fetchall()
        for r in rows:
            if r["family"] in fams:
                out.setdefault(r["family"], []).append(r["close"])
        # метки времени возьмём из самой длинной семьи
        return out, fams
    for fam in fams:
        inst = con.execute(
            "SELECT i.id, i.secid FROM instruments i "
            "WHERE i.family=? AND i.last_trade_date >= date('now') "
            "ORDER BY i.last_trade_date ASC, i.id ASC LIMIT 1", (fam,)).fetchone()
        if not inst:
            inst = con.execute(
                "SELECT i.id, i.secid FROM instruments i "
                "WHERE i.family=? ORDER BY i.last_trade_date DESC, i.id DESC LIMIT 1",
                (fam,)).fetchone()
        if not inst:
            continue
        rows = con.execute(
            "SELECT time, close FROM candles WHERE instrument_id=? AND interval=? ORDER BY time",
            (inst["id"], interval)).fetchall()
        if rows:
            out[fam] = [r["close"] for r in rows]
    return out, fams


def _corr(x, y):
    """Пирсон: x — ведущий ряд, y — запаздывающий (корреляция лага).
    None-значения в любой позиции — отбрасываются парами."""
    pairs = [(a, b) for a, b in zip(x, y) if a is not None and b is not None]
    n = len(pairs)
    if n < 5:
        return None
    xs = [p[0] for p in pairs]
    ys = [p[1] for p in pairs]
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((a - mx) * (b - my) for a, b in pairs)
    dx = sum((a - mx) ** 2 for a in xs)
    dy = sum((b - my) ** 2 for b in ys)
    if dx <= 0 or dy <= 0:
        return None
    return num / ((dx * dy) ** 0.5)


def log_returns(series):
    """Лог-доходности ln(c[i]/c[i-1]); NaN на первом баре."""
    import math
    out = [None] * len(series)
    for i in range(1, len(series)):
        p0, p1 = series[i - 1], series[i]
        if p0 is not None and p1 is not None and p0 > 0 and p1 > 0:
            out[i] = math.log(p1 / p0)
    return out


def ml_correlation_matrix(con, interval="1d", lag=1):
    """Матрица корреляций лог-доходностей со сдвигом lag:
    r[isource][itarget] = corr(logRet[source][t], logRet[target][t+lag])
    (source сдвигают назад — source ведёт target)."""
    series, fams = _family_series(con, interval)
    fams = [f for f in fams if len(series.get(f, [])) > lag + 2]
    n = len(fams)
    rets = {f: log_returns(series[f]) for f in fams}
    # согласуем длину рядов: обрезаем под минимальный
    valid = [f for f in fams if sum(1 for v in rets[f] if v is not None) > lag + 2]
    if not valid:
        return {"families": [], "matrix": [], "lag": lag, "interval": interval}
    min_len = min(len(rets[f]) for f in valid)
    mat = [[None] * len(valid) for _ in valid]
    for i, fi in enumerate(valid):
        a = [v for v in rets[fi][:min_len]]
        for j, fj in enumerate(valid):
            if i == j and lag == 0:
                mat[i][j] = 1.0
                continue
            if i == j:
                # автокорреляция лага: тот же ряд со сдвигом
                ys = [v for v in rets[fj][:min_len]]
                x = a[:min_len - lag]
                y = ys[lag:]
                mat[i][j] = _corr(x, y)
                continue
            y = [v for v in rets[fj][:min_len]]
            x = a[:min_len - lag]
            yy = y[lag:]
            mat[i][j] = _corr(x, yy)
    return {"families": valid, "matrix": mat, "lag": lag, "interval": interval}


def ml_best_lags(con, interval="1d", lags=None):
    """Для каждой пары (isource != itarget) — лучший лаг по |r| из lags."""
    lags = lags or LAG_PRESETS.get(interval, [1, 2, 3, 5])
    out = []
    fams = [r[0] for r in con.execute(
        "SELECT DISTINCT family FROM instruments").fetchall()]
    fams = [f for f in ML_FAMILIES if f in fams]
    if interval == "1d":
        rows = con.execute(
            "SELECT family, dt, close FROM continuous ORDER BY family, dt").fetchall()
    else:
        rows = []
    series = {}
    if interval == "1d":
        for r in rows:
            if r["family"] in ML_FAMILIES:
                series.setdefault(r["family"], []).append(r["close"])
    else:
        series, _ = _family_series(con, interval)
    fams = [f for f in fams if len(series.get(f, [])) > max(lags) + 2]
    rets = {f: log_returns(series[f]) for f in fams}
    min_len = min(len(rets[f]) for f in fams) if fams else 0
    if min_len <= 2:
        return {"pairs": [], "interval": interval}
    for i, fi in enumerate(fams):
        for j, fj in enumerate(fams):
            if i == j:
                continue
            a = [v for v in rets[fi][:min_len]]
            bb = [v for v in rets[fj][:min_len]]
            best = {"lag": None, "r": 0}
            for lag in lags:
                x = a[:min_len - lag]
                y = bb[lag:]
                r = _corr(x, y)
                if r is not None and abs(r) > abs(best["r"]):
                    best = {"lag": lag, "r": r}
            if best["lag"] is not None:
                lag = best["lag"]
                x = a[:min_len - lag]
                y = bb[lag:]
                pairs = [(xv, yv) for xv, yv in zip(x, y)
                         if xv is not None and yv is not None]
                if len(pairs) < 5:
                    continue
                n = len(pairs)
                gross = 0.0
                hits = 0
                for xv, yv in pairs:
                    s = 1 if xv > 0 else (-1 if xv < 0 else 0)
                    gross += s * yv
                    if (s > 0) == (yv > 0):
                        hits += 1
                fee = 0.00015 * n * 1000000.0
                profit = round(gross * 1000000.0 - fee)
                out.append({"source": fi, "target": fj, "lag": lag,
                            "r": round(best["r"], 4),
                            "acc": round(hits / n, 3), "n": n,
                            "profit": profit})
    out.sort(key=lambda p: -abs(p["r"]))
    return {"pairs": out, "interval": interval}


# ── Модель стратегий: ликвидность, комиссия (Финам N6 «Трейдер»), сделок/сутки ──
FINAM_COMM = {
    "futures": 1.2,     # ₽ за контракт (до 1,2 ₽), вход и выход отдельно
    "spot": 0.00025,    # до 0,025% от оборота для ценных бумаг РФ (drаг/ETF)
}
BARS_PER_DAY = {"1d": 1, "60min": 14, "10min": 70}


def _front_registry(con):
    """По каждому семейству — торговый инструмент (фронт) + цена + ликвидность (руб/день)."""
    ins = {}
    for r in con.execute(
            "SELECT id, secid, family, name, type, last_trade_date FROM instruments").fetchall():
        ins.setdefault(r["family"], []).append(dict(r))
    liq = {}
    for r in con.execute("""
        SELECT i.family, i.secid,
               ROUND(SUM(ca.close * ca.volume) / COUNT(DISTINCT ca.dt)) liq_day,
               ROUND(AVG(ca.close), 4) avg_close
        FROM (SELECT instrument_id, substr(time,1,10) dt, close, volume
              FROM candles WHERE interval='60min'
                AND time >= datetime('now','-6 days')) ca
        JOIN instruments i ON i.id = ca.instrument_id
        GROUP BY i.family, i.secid""").fetchall():
        liq[(r["family"], r["secid"])] = {"liq_day": r["liq_day"] or 0,
                                          "avg_close": r["avg_close"] or 0}
    out = {}
    for fam, items in ins.items():
        items.sort(key=lambda x: x["last_trade_date"] or "9999")
        # активные (exp не истёк) → ближайший экспирацией; иначе последний по экспирации
        idx = next((i for i, x in enumerate(items)
                    if x["last_trade_date"] and x["last_trade_date"] > datetime.utcnow().strftime("%F")),
                   len(items) - 1)
        it = items[idx]
        lq = liq.get((fam, it["secid"]), {"liq_day": 0, "avg_close": 0})
        out[fam] = {"secid": it["secid"], "type": it["type"], "name": it["name"],
                    "liq_day": lq["liq_day"], "avg_close": lq["avg_close"]}
    return out


def ml_strategies(con, interval="1d", ignore_com=0):
    """Топ-стратегии по доходу на 1 млн ₽: база ml_best_lags + ликвидность и комиссия."""
    base = ml_best_lags(con, interval)
    reg = _front_registry(con)
    bpd = BARS_PER_DAY.get(interval, 14)
    out = []
    for p in base.get("pairs", []):
        s, t = reg.get(p["source"]), reg.get(p["target"])
        if not s or not t:
            continue
        trades = max(1, round(bpd / max(p["lag"], 1)))  # сделок/сутки ≈ баров в день / лаг
        # контрактов на 1 млн ₽ позиции (по цене контракта)
        contracts = int(1_000_000 / t["avg_close"]) if t["avg_close"] > 0 else 0
        if s["type"] == "futures" and t["type"] == "futures":
            fee_per_trade = max(contracts, 1) * FINAM_COMM["futures"]  # 1,2 ₽/контракт
        else:
            fee_per_trade = 1_000_000 * FINAM_COMM["spot"]             # 0,025%
        fee_day = round(2 * fee_per_trade * trades)                     # вход+выход × сделок/сутки
        # чистая прибыль на 1 млн за горизонт: валовый лог-доход минус комиссия
        profit_gross = (p.get("profit") or 0) + round(0.00015 * p.get("n", 0) * 1_000_000)  # вернуть 0,015%-вычет из best_lags
        fee_total = round(2 * fee_per_trade * p["n"])                   # за n барных сделок
        profit_finam = profit_gross - fee_total if not ignore_com else profit_gross
        out.append({**p,
                    "source_secid": s["secid"], "target_secid": t["secid"],
                    "source_type": s["type"], "target_type": t["type"],
                    "liq_source": s["liq_day"], "liq_target": t["liq_day"],
                    "avg_close": t["avg_close"], "contracts": contracts,
                    "trades_day": trades, "fee_day": fee_day, "fee_total": fee_total,
                    "profit_finam": profit_finam})
    out.sort(key=lambda x: -x["profit_finam"])
    return {"interval": interval, "bars_day": bpd, "fee": FINAM_COMM,
            "pairs": out, "ts": time.time()}