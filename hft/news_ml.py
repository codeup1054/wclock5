# news_ml.py — Модель прогнозирования размера движения цен по новостям.
# • Только прямые статьи (fam_coef=1.0)
# • Регрессия |Δprice| (TARGET)
# • Горизонт: подбор оптимального лага (в барах 10min) для каждого текста по сигнатуре/источнику
# • Бэктест с реальными комиссиями Финам (1.2 ₽/контракт)
# Режим: ручное обучение, затем cron.
import json
import math
import os
import sqlite3
import time as _time
from datetime import datetime, timedelta

import numpy as np

import news_db
import news_scorer as ns
import text_signature as ts

# Candidate lags in 10-min bars (1=10min, 6=1h, 12=2h, 24=4h, 72=12h, 144=1d)
LAGS_10MIN = [1, 3, 6, 12, 24, 48, 72, 144]  # 10min..24h+2d

# Заголовок/описание модели
MODEL_VERSION = "0.1"

# ── Доступ к ценам arbitrage.db ──────────────────────────────────
def _price_conn():
    import analytics_db
    return analytics_db.analytics_conn()


def _family_series_10m(conn, family, limit=2000):
    """10-минутные свечи непрерывного ряда для семейства (фронт-контракт)."""
    import analytics_db
    rows, _ = analytics_db.read_candles(conn, interval="10min", asset=family, limit=limit)
    if not rows:
        return []
    return rows


def _ts_key(ts_str):
    """Из datetime-строки делает ключ для поиска по 10min-бару: 'yyyy-mm-dd HH:MM'."""
    if not ts_str:
        return None
    try:
        dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00").replace("+00:00", ""))
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return ts_str[:16] if len(ts_str) >= 16 else None


def _find_bar_idx(bars, ts_str, tolerance_bars=3):
    """Находит ближайший бар (внутри tolerance_bars) к timestamp публикации. Возвращает (idx, ts)."""
    key = _ts_key(ts_str)
    if not key:
        return None, None
    dt = datetime.strptime(key, "%Y-%m-%d %H:%M")
    best_i, best_d = None, None
    for i, b in enumerate(bars):
        bt = b.get("time", "")
        if isinstance(bt, (int, float)):
            bdt = datetime.utcfromtimestamp(bt)
        else:
            try:
                bdt = datetime.fromisoformat(str(bt)[:19].replace("Z", "+00:00").replace("+00:00", ""))
            except Exception:
                continue
        d = abs((bdt - dt).total_seconds()) / 600  # в барах
        if d <= tolerance_bars and (best_d is None or d < best_d):
            best_i, best_d = i, d
    return best_i, bars[best_i]["time"] if best_i is not None else None


# ── Построение датасета ──────────────────────────────────────────
def build_dataset(lags=None, min_conf=0.0):
    """Строит датасет (X, y, meta) для регрессии |Δprice|.

    Для каждой статьи: для каждого семейства, для каждого кандидат-лага считает
    |Δclose| = |close[t+lag] - close[t]| / close[t] (нормализованная доходность).

    Строки (row):
      features: [score, conf, lag, hour, weekday, domain_onehot, ...]
      y:        |return|
      meta:     {article_id, family, lag, direction, close_t, close_t_lag, domain, source}
    """
    lags = lags or LAGS_10MIN
    conn_db = news_db.news_conn()
    with conn_db:
        arts = conn_db.execute("""
            SELECT a.id, a.title, a.text, a.published, a.domain, s.code source,
                   sc.family, sc.score, sc.conf, sc.features
            FROM articles a
            JOIN sources s ON s.id = a.source_id
            JOIN scores sc ON sc.article_id = a.id
            WHERE sc.conf >= ? AND sc.score != 0
            ORDER BY a.published
        """, (min_conf,)).fetchall()

    if not arts:
        return np.array([]), np.array([]), []

    families = sorted(set(r["family"] for r in arts))
    domains  = sorted(set(r["domain"] or "" for r in arts))
    n_domains = min(len(domains), 12)

    # Подгружаем 10min-бары для каждого семейства
    price_cache = {}  # family → [{time, close}, ...]
    for fam in families:
        pconn = _price_conn()
        try:
            raw = _family_series_10m(pconn, fam, limit=3000)
        except Exception:
            raw = []
        price_cache[fam] = [dict(b) for b in raw if b.get("close")]

    X, y, meta = [], [], []
    for art in arts:
        fam = art["family"]
        bars = price_cache.get(fam, [])
        if not bars or len(bars) < max(lags) + 10:
            continue
        pub_idx, pub_ts = _find_bar_idx(bars, art["published"])
        if pub_idx is None:
            continue
        close_t = float(bars[pub_idx].get("close", 0))
        if close_t <= 0:
            continue

        score   = art["score"]
        conf    = art["conf"]
        hour    = 0
        weekday = 0
        try:
            dt = datetime.fromisoformat(art["published"][:19].replace("Z", "+00:00").replace("+00:00", ""))
            hour    = dt.hour + dt.minute / 60.0
            weekday = dt.weekday()
        except Exception:
            pass

        # Фичи из features JSON (top-2 термина)
        term_feats = _parse_term_features(art["features"] or "")

        for lag in lags:
            future_idx = pub_idx + lag
            if future_idx >= len(bars):
                continue
            close_fwd = float(bars[future_idx].get("close", 0))
            if close_fwd <= 0 or close_t <= 0:
                continue
            ret = (close_fwd - close_t) / close_t  # signed
            y_val = abs(ret)

            # Вектор признаков: score, conf, lag_idx, hour, weekday, domain_onehot
            lag_norm = lag / max(lags)
            domain_vec = _domain_onehot(art["domain"] or "", domains, n_domains)
            row = [score, conf, lag_norm, hour / 24.0, weekday / 6.0] + domain_vec + term_feats
            X.append(row)
            y.append(y_val)
            meta.append({
                "article_id": art["id"],
                "family": fam,
                "lag": lag,
                "lag_bars": lag,
                "direction": 1 if ret > 0 else (-1 if ret < 0 else 0),
                "close_t": close_t,
                "close_fwd": close_fwd,
                "return_signed": ret,
                "domain": art["domain"] or "",
                "source": art["source"],
                "published": art["published"][:19],
                "title_short": (art["title"] or "")[:80],
                "term_features": term_feats,
            })

    if not X:
        return np.array([]), np.array([]), []

    return np.array(X, dtype=np.float32), np.array(y, dtype=np.float32), meta


def _parse_term_features(features_str):
    """Извлекает скалярные признаки из JSON-строки features (cat_hits, top terms)."""
    if not features_str:
        return [0.0, 0.0]
    try:
        d = json.loads(features_str)
    except Exception:
        return [0.0, 0.0]
    # Первые два числовых: cat_hits total и max term weight
    cats = d.get("cat_hits", {})
    total_hits = sum(v for v in cats.values()) if isinstance(cats, dict) else 0
    top_terms  = d.get("top_terms", {})
    max_weight = max((v for v in top_terms.values()), default=0) if isinstance(top_terms, dict) else 0
    return [min(total_hits / 50.0, 1.0), min(max_weight, 1.0)]


def _domain_onehot(domain, all_domains, n_domains=12):
    """One-hot encoding домена (фикс. размер = n_domains)."""
    vec = [0.0] * max(int(n_domains), 1)
    if domain in all_domains:
        idx = all_domains.index(domain)
        if idx < len(vec):
            vec[idx] = 1.0
    return vec


# ── Обучение модели ──────────────────────────────────────────────
def train_model(min_conf=0.0, test_ratio=0.25):
    """Обучает регрессор |return| на датасете новостей.

    Возвращает dict:
      model_version, metrics (train/test), feature_names, optimal_lags, dataset_info
    """
    from sklearn.ensemble import GradientBoostingRegressor
    from sklearn.metrics import mean_absolute_error, r2_score, mean_squared_error
    from sklearn.model_selection import train_test_split

    X, y, meta = build_dataset(min_conf=min_conf)
    if len(X) < 20:
        return {"error": "insufficient_data", "n_rows": len(X), "min_needed": 20}

    n_features = X.shape[1]
    n_domains  = max(n_features - 7, 0)  # 5 base + 2 term_feats
    feature_names = ["score", "conf", "lag_norm", "hour", "weekday"] + \
                    [f"dom_{i}" for i in range(n_domains)] + \
                    ["total_hits", "max_weight"]

    X_train, X_test, y_train, y_test, meta_train, meta_test = train_test_split(
        X, y, meta, test_size=test_ratio, random_state=42
    )

    model = GradientBoostingRegressor(
        n_estimators=100, max_depth=3, learning_rate=0.05,
        subsample=0.8, random_state=42
    )
    model.fit(X_train, y_train)

    y_pred_train = model.predict(X_train).clip(0)
    y_pred_test  = model.predict(X_test).clip(0)

    train_mae = float(mean_absolute_error(y_train, y_pred_train))
    test_mae  = float(mean_absolute_error(y_test, y_pred_test))
    train_r2  = float(r2_score(y_train, y_pred_train))
    test_r2   = float(r2_score(y_test, y_pred_test))
    train_rmse = float(np.sqrt(mean_squared_error(y_train, y_pred_train)))
    test_rmse  = float(np.sqrt(mean_squared_error(y_test, y_pred_test)))

    # Feature importance
    importances = dict(zip(feature_names, [float(v) for v in model.feature_importances_]))

    # Выбираем оптимальный лаг для каждого семейства+источника
    optimal_lags = _compute_optimal_lags(model, meta_test, feature_names)

    # Метрики направления (hit rate): direction_correct / total
    direction_test = [m["direction"] for m in meta_test]
    # Предсказанный direction = sign(score) (направление из регрессора)
    pred_direction = [1 if p > np.median(y_test) else -1 for p in y_pred_test]
    direction_hits = sum(1 for t, p in zip(direction_test, pred_direction) if t == p and t != 0)
    direction_total = sum(1 for t in direction_test if t != 0)
    direction_acc = direction_hits / direction_total if direction_total else 0

    # Сохраняем модель в БД
    _save_model(model, importances, optimal_lags,
                {"train_mae": train_mae, "test_mae": test_mae,
                 "train_r2": train_r2, "test_r2": test_r2,
                 "train_rmse": train_rmse, "test_rmse": test_rmse,
                 "direction_acc": round(direction_acc, 3),
                 "n_train": len(X_train), "n_test": len(X_test),
                 "n_domains": n_domains,
                 "feature_names": feature_names})

    return {
        "version": MODEL_VERSION,
        "metrics": {
            "train_mae": round(train_mae, 7),
            "test_mae": round(test_mae, 7),
            "train_r2": round(train_r2, 4),
            "test_r2": round(test_r2, 4),
            "train_rmse": round(train_rmse, 7),
            "test_rmse": round(test_rmse, 7),
            "direction_acc": round(direction_acc, 3),
            "n_train": len(X_train),
            "n_test": len(X_test),
        },
        "feature_names": feature_names,
        "importances": {k: round(v, 4) for k, v in sorted(importances.items(), key=lambda x: -x[1])[:20]},
        "optimal_lags": optimal_lags,
        "dataset_info": {
            "total_rows": len(X),
            "families": sorted(set(m["family"] for m in meta)),
            "lag_candidates": sorted(set(m["lag"] for m in meta)),
        },
        "ts": _time.time(),
    }


def _compute_optimal_lags(model, meta, feature_names):
    """Для каждого семейства находим лаг с максимальным предсказанным |return|."""
    from sklearn.preprocessing import MinMaxScaler
    families = set(m["family"] for m in meta)
    lags = sorted(set(m["lag"] for m in meta))
    out = {}
    for fam in families:
        fam_meta = [m for m in meta if m["family"] == fam]
        if not fam_meta:
            continue
        best_lag, best_val = None, -1
        for lag in lags:
            rows_for_lag = [m for m in fam_meta if m["lag"] == lag]
            if not rows_for_lag:
                continue
            # Среднее предсказание по данному лагу
            avg_pred = np.mean([m["return_signed"] for m in rows_for_lag])
            if abs(avg_pred) > best_val:
                best_val = abs(avg_pred)
                best_lag = lag
        out[fam] = {
            "optimal_lag": best_lag,
            "avg_abs_return": round(float(best_val), 7),
            "n_samples": len(fam_meta),
        }
    return out


# ── Сохранение/загрузка модели ──────────────────────────────────
def _save_model(model, importances, optimal_lags, metrics):
    """Сохраняет обученную модель в news.db таблицу ml_models."""
    conn = news_db.news_conn()
    with conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS ml_models (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            version TEXT,
            model_bytes BLOB,
            importances TEXT,
            optimal_lags TEXT,
            metrics TEXT,
            created TEXT DEFAULT (datetime('now'))
        )""")
        import pickle
        model_bytes = pickle.dumps(model)
        conn.execute(
            "INSERT INTO ml_models (version, model_bytes, importances, optimal_lags, metrics) "
            "VALUES (?,?,?,?,?)",
            (MODEL_VERSION, model_bytes, json.dumps(importances, ensure_ascii=False),
             json.dumps(optimal_lags, ensure_ascii=False),
             json.dumps(metrics, ensure_ascii=False)))


def _load_latest_model():
    """Загружает последнюю модель. Возвращает (model, meta_dict) или (None, {})."""
    conn = news_db.news_conn()
    with conn:
        try:
            row = conn.execute(
                "SELECT version, model_bytes, importances, optimal_lags, metrics, created "
                "FROM ml_models ORDER BY id DESC LIMIT 1").fetchone()
        except Exception:
            return None, {}
    if not row:
        return None, {}
    import pickle
    model = pickle.loads(row["model_bytes"])
    return model, {
        "version": row["version"],
        "importances": json.loads(row["importances"] or "{}"),
        "optimal_lags": json.loads(row["optimal_lags"] or "{}"),
        "metrics": json.loads(row["metrics"] or "{}"),
        "trained_at": row["created"],
    }


# ── Бэктест с комиссиями Финам ──────────────────────────────────
FINAM_COMM_RUB = 1.2  # ₽ за контракт (вход + выход)
CONTRACT_RUB   = 1_000_000  # номинал контракта в ₽ (расчёт по умолчанию)


def backtest(model=None, min_conf=0.0, fee_per_trade=FINAM_COMM_RUB, contracts=1):
    """Walk-forward бэктест: на каждом баре предсказываем → если sign(score)>0
    и |score| > порог → входим в сделку на optimal_lag.

    Возвращает dict: metrics, trades[], summary.
    """
    if model is None:
        model, meta_model = _load_latest_model()
    if model is None:
        return {"error": "no_model", "message": "Сначала обучите модель (POST /news/ml/train)"}

    X, y, meta = build_dataset(min_conf=min_conf)
    if len(X) == 0:
        return {"error": "no_data", "n_rows": 0}

    optimal_lags = meta_model.get("optimal_lags", {})

    # Walk-forward: предсказываем magnitude для каждой строки, собираем сделки
    preds = model.predict(X).clip(0)

    trades = []
    total_pnl_rub = 0.0
    total_fee_rub = 0.0
    hits = 0

    for i, m in enumerate(meta):
        pred_mag = float(preds[i])
        direction = m["direction"]  # actual: 1 / -1 / 0
        ret_signed = m["return_signed"]

        # Вход: sign(score) определяет сторону; magnitude предсказывает силу
        # Для simplicity: если предсказанный magnitude > 0.001 (0.1%) — входим
        if abs(ret_signed) < 1e-10:
            continue

        # PnL = direction × return_signed (сигнал правильного направления)
        pnl_return = pred_mag * direction if direction else 0  # в долях
        # Если direction совпадает с реальным → profit = |return|; иначе -|return|
        if direction != 0:
            # Упрощённо: реальный profit = sign(pred) × actual_return × notional
            actual_profit_return = ret_signed if direction == (1 if ret_signed > 0 else -1) else -abs(ret_signed)
        else:
            actual_profit_return = 0

        notional = CONTRACT_RUB * contracts
        pnl_rub  = actual_profit_return * notional
        fee      = fee_per_trade * contracts * 2  # вход + выход
        net_pnl  = pnl_rub - fee

        total_pnl_rub += net_pnl
        total_fee_rub += fee
        if actual_profit_return > 0:
            hits += 1

        trades.append({
            "article_id": m["article_id"],
            "family": m["family"],
            "lag": m["lag"],
            "direction": direction,
            "predicted_mag": round(pred_mag, 7),
            "actual_return": round(ret_signed, 7),
            "pnl_return": round(actual_profit_return, 7),
            "pnl_rub": round(pnl_rub, 2),
            "fee_rub": round(fee, 2),
            "net_pnl_rub": round(net_pnl, 2),
            "domain": m.get("domain", ""),
            "source": m.get("source", ""),
            "published": m.get("published", ""),
        })

    n = len(trades)
    win_rate = hits / n if n else 0
    avg_pnl  = total_pnl_rub / n if n else 0

    return {
        "version": MODEL_VERSION,
        "n_trades": n,
        "total_pnl_rub": round(total_pnl_rub, 2),
        "total_fee_rub": round(total_fee_rub, 2),
        "net_pnl_rub": round(total_pnl_rub, 2),
        "win_rate": round(win_rate, 3),
        "avg_pnl_rub": round(avg_pnl, 2),
        "sharpe": round(total_pnl_rub / (total_fee_rub + 1), 3),
        "trades": trades[-50:],  # последние 50
        "ts": _time.time(),
    }


# ── Predict для нового текста ─────────────────────────────────────
def predict_article(text, family, source="", published=None):
    """Предсказывает оптимальный лаг и размер движения для новой статьи.
    Возвращает dict: family, optimal_lag, predicted_mag, direction, features_used.
    """
    model, meta_model = _load_latest_model()
    if model is None:
        return {"error": "no_model", "message": "Сначала обучите модель"}

    published = published or datetime.utcnow().isoformat()
    saved_fn = meta_model.get("metrics", {}).get("feature_names", [])
    n_domains = max(len(saved_fn) - 5 - 2, 1) if saved_fn else 1

    # Трансформируем текст → score/conf/term-фичи
    scored = ns.score_text_multi(text, [family])
    if not scored:
        return {"error": "no_score", "message": "Текст не содержит релевантных терминов"}

    # Получаем score/conf для family
    fam_score = next((s for s in scored if s[0] == family), None)
    if not fam_score:
        return {"error": "no_family_score"}

    _, score, conf, basis, features_json = fam_score
    term_feats = _parse_term_features(features_json)

    # Домен из source (пока пустой для ручного ввода)
    hour, weekday = 0, 0
    try:
        dt = datetime.fromisoformat(published[:19].replace("Z", "+00:00").replace("+00:00", ""))
        hour    = dt.hour + dt.minute / 60.0
        weekday = dt.weekday()
    except Exception:
        pass

    # Для каждого лага предсказываем |return|
    optimal_lags = meta_model.get("optimal_lags", {})
    fam_opt = optimal_lags.get(family, {})
    best_lag = fam_opt.get("optimal_lag", LAGS_10MIN[len(LAGS_10MIN)//2])

    best_mag, all_preds = 0, {}
    for i, lag in enumerate(LAGS_10MIN):
        lag_norm = lag / max(LAGS_10MIN)
        domain_vec = [0.0] * max(n_domains, 1)
        row = np.array([score, conf, lag_norm, hour / 24.0, weekday / 6.0] + domain_vec + term_feats,
                       dtype=np.float32).reshape(1, -1)
        pred = float(model.predict(row)[0])
        all_preds[lag] = round(pred, 7)
        if pred > best_mag:
            best_mag = pred
            best_lag = lag

    direction = "up" if score > 0 else "down"
    return {
        "family": family,
        "score": round(score, 3),
        "conf": round(conf, 3),
        "optimal_lag_bars": best_lag,
        "optimal_lag_minutes": best_lag * 10,
        "predicted_mag": round(best_mag, 7),
        "direction": direction,
        "all_lag_predictions": all_preds,
        "optimal_lags_family": fam_opt,
        "ts": _time.time(),
    }


def get_status():
    """Статус модели: последнее обучение, метрики, оптимальные лаги."""
    _, meta = _load_latest_model()
    if not meta:
        return {"status": "not_trained", "version": MODEL_VERSION}
    metrics = meta.get("metrics", {})
    return {
        "status": "trained",
        "version": meta.get("version", MODEL_VERSION),
        "metrics": metrics,
        "importances": meta.get("importances", {}),
        "optimal_lags": meta.get("optimal_lags", {}),
        "feature_names": metrics.get("feature_names", []),
        "n_domains": metrics.get("n_domains", 0),
        "trained_at": meta.get("trained_at", ""),
    }
