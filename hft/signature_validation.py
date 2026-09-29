# signature_validation.py — Валидация сигнатур против фактического движения цен.
# Для каждой статьи: сигнатура (score по семействам) vs Δprice соответствующего
# семейства через 1/2/3/5 дней. Метрики: Spearman ρ, hit rate, ROC (up/down).
import os
import re
import math
from datetime import datetime, timedelta

import numpy as np

import news_db
import text_signature as ts


# ── Чтение цен из arbitrage.db ──────────────────────────────────
def _price_conn():
    import analytics_db
    return analytics_db.analytics_conn()


def _family_series(conn, family, interval="1d"):
    """Дневной ряд цен для семейства через continuous (для 1d — family как asset)."""
    import analytics_db
    if interval == "1d":
        rows, _src = analytics_db.read_candles(conn, interval=interval, asset=family, limit=0)
        return rows
    assets = analytics_db.list_instruments(con=conn, family=family)
    if not assets:
        return []
    # активный (мин. экспирация ≥ сегодня), иначе последний
    active = [a for a in assets if (a.get("last_trade_date") or "") >= datetime.now().strftime("%Y-%m-%d")]
    asset = (active[0] if active else assets[-1])
    secid = asset["secid"] if isinstance(asset, dict) else asset
    rows, _src = analytics_db.read_candles(conn, interval=interval, asset=secid, limit=0)
    return rows  # [{time, open, high, low, close, volume}]


def _price_maps(conn, interval="1d"):
    """Словарь family → {date(yyyy-mm-dd): close}."""
    fams = ts.FAMILIES
    maps = {}
    for fam in fams:
        try:
            rows = _family_series(conn, fam, interval)
        except Exception:
            rows = []
        m = {}
        for r in rows:
            t = r.get("time") or ""
            if isinstance(t, (int, float)):
                # unix ts → дню
                dt = datetime.utcfromtimestamp(t)
                key = dt.strftime("%Y-%m-%d")
            else:
                key = str(t)[:10]
            try:
                c = float(r.get("close"))
                m.setdefault(key, c)
            except (TypeError, ValueError):
                continue
        maps[fam] = m
    return maps


def _next_return(price_map, date_str, days=1):
    """Доходность от date_str через N дней: (close[t+days]/close[t]) - 1.
    Если нет точного t+days — берём последнюю доступную после."""
    if date_str not in price_map:
        return None
    base = price_map[date_str]
    d = datetime.strptime(date_str, "%Y-%m-%d")
    target = d + timedelta(days=days)
    # ищем точно + не дальше 2 дней
    candidates = []
    for dd in range(days, days + 4):
        k = (d + timedelta(days=dd)).strftime("%Y-%m-%d")
        if k in price_map:
            candidates.append(price_map[k])
    if not candidates:
        return None
    fwd = candidates[0]
    return (fwd / base) - 1.0 if base else None


def validate(method="hybrid", interval="1d", horizons=(1, 2, 3, 5)):
    """Корреляция сигнатур с будущими доходностями по семействам.

    Возвращает: {method, n_articles, horizons: {days: {spearman, hit_rate, n}}}.
    """
    import scipy.stats as st

    conn_db = news_db.news_conn()
    with conn_db:
        articles = conn_db.execute(
            "SELECT id, text, title, published FROM articles ORDER BY published"
        ).fetchall()
    if not articles:
        return {"method": method, "n_articles": 0, "horizons": {}}

    # Цены
    pconn = _price_conn()
    price_maps = _price_maps(pconn, interval=interval)

    # Сигнатуры
    builder = ts.SignatureBuilder.create(method)
    texts = [r["text"] or r["title"] or "" for r in articles if r["text"] or r["title"]]
    if texts and method != "lexicon":
        builder.fit(texts)

    rows = []  # list of (family, score_abs, ret)
    for art in articles:
        text = art["text"] or art["title"] or ""
        if not text:
            continue
        sig, conf, feats = builder.transform(text)
        pub = art["published"] or ""
        date_str = pub[:10]
        if not date_str or date_str < "2020-01-01":
            continue
        for fam in ts.FAMILIES:
            pm = price_maps.get(fam)
            if not pm or date_str not in pm:
                continue
            score = sig.get(fam, 0.0)
            r1 = _next_return(pm, date_str, 1)
            if r1 is not None:
                rows.append({"family": fam, "date": date_str, "score": score, "ret": r1})

    if not rows:
        return {"method": method, "n_articles": len(articles), "horizons": {}}

    results = {
        "method": method,
        "n_articles": len(articles),
        "n_matched_points": len(rows),
        "horizons": {},
    }
    # дублируем для каждого горизонта (пересчёт без точного совпадения ок)
    score_arr = np.array([r["score"] for r in rows])
    import scipy.stats as st2
    for h in horizons:
        rets = []
        for r in rows:
            rt = _next_return(price_maps.get(r["family"]), r["date"], h)
            rets.append(rt if rt is not None else float("nan"))
        rets = np.array(rets)
        mask = ~np.isnan(rets)
        if mask.sum() < 10:
            results["horizons"][h] = {"n": int(mask.sum()), "n_family": 0}
            continue
        s = score_arr[mask]
        rv = rets[mask]
        try:
            rho, pval = st2.spearmanr(s, rv)
        except Exception:
            rho, pval = float("nan"), float("nan")
        # hit rate: знак совпадения (score>0 → ret>0; score<0 → ret<0)
        hit = np.mean(np.sign(s) == np.sign(rv)) if len(s) else 0
        results["horizons"][h] = {
            "n": int(len(s)),
            "spearman_rho": round(float(rho) if not math.isnan(rho) else 0, 4),
            "pvalue": round(float(pval) if not math.isnan(pval) else 1, 4),
            "hit_rate": round(float(hit), 3),
            "n_family": int(len(s)),
        }
    return results


def compare_methods(interval="1d"):
    """Сравнение всех подходов на одном датасете статей."""
    out = {}
    for method in ("lexicon", "hybrid", "tfidf"):
        try:
            out[method] = validate(method, interval=interval)
        except Exception as e:
            out[method] = {"method": method, "error": str(e)}
    return out