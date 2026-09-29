# analytics_api.py — Blueprint «Аналитика рынка» для hft-app.
# Читает arbitrage.db (54.Hft: сбор данных MOEX ISS), отдаёт JSON для UI.
import time
from flask import Blueprint, jsonify, request

import analytics_db
import news_db
import news_scorer

bp = Blueprint("analytics", __name__, url_prefix="/api/analytics")


def ok(data, **extra):
    out = {"ok": True, **extra}
    out.update(data)
    return jsonify(out)


def err(msg, code=400):
    return jsonify({"ok": False, "error": msg}), code


@bp.route("/meta")
def meta():
    try:
        con = analytics_db.analytics_conn()
    except FileNotFoundError as e:
        return err(str(e), 500)
    with con:
        families = analytics_db.list_families(con)
        instruments = analytics_db.list_instruments(con)
    return ok({"families": families, "instruments": instruments,
               "ts": time.time()})


@bp.route("/instruments")
def instruments():
    family = request.args.get("family")
    try:
        con = analytics_db.analytics_conn()
    except FileNotFoundError as e:
        return err(str(e), 500)
    with con:
        rows = analytics_db.list_instruments(con, family)
    return ok({"instruments": rows, "ts": time.time()})


@bp.route("/candles")
def candles():
    interval = request.args.get("interval", "1d")
    asset = request.args.get("asset", "GOLD")
    limit = request.args.get("limit", "0")
    try:
        con = analytics_db.analytics_conn()
    except FileNotFoundError as e:
        return err(str(e), 500)
    with con:
        rows, src = analytics_db.read_candles(con, interval=interval, asset=asset, limit=limit)
    return ok({"asset": asset, "interval": interval, "source": src,
               "candles": rows, "ts": time.time()})


@bp.route("/data")
def data_summary():
    """Сводка скачанных данных по семействам и интервалам для поиска пар."""
    try:
        con = analytics_db.analytics_conn()
    except FileNotFoundError as e:
        return err(str(e), 500)
    with con:
        summary = analytics_db.dataset_summary(con)
    return ok(summary)


@bp.route("/series")
def series():
    """Непрерывные ряды по парам «металл — энергия» (1d) для спред-анализа."""
    interval = request.args.get("interval", "1d")
    limit = request.args.get("limit", "0")
    try:
        con = analytics_db.analytics_conn()
    except FileNotFoundError as e:
        return err(str(e), 500)
    with con:
        series = analytics_db.read_series_for_pair(con, interval=interval, limit=limit)
    return ok({"interval": interval, "series": series, "ts": time.time()})


@bp.route("/ml/matrix")
def ml_matrix():
    """Корреляционная матрица лог-доходностей со сдвигом lag (ML-раздел)."""
    try:
        con = analytics_db.analytics_conn()
    except FileNotFoundError as e:
        return err(str(e), 500)
    interval = request.args.get("interval", "1d")
    lag = int(request.args.get("lag", "1") or 1)
    with con:
        res = analytics_db.ml_correlation_matrix(con, interval=interval, lag=max(lag, 0))
    return ok(res, ts=time.time())


@bp.route("/ml/best_lags")
def ml_best_lags():
    """Автоподбор лучшего лага по |r| для каждой пары (ML-раздел)."""
    try:
        con = analytics_db.analytics_conn()
    except FileNotFoundError as e:
        return err(str(e), 500)
    interval = request.args.get("interval", "1d")
    with con:
        res = analytics_db.ml_best_lags(con, interval=interval)
    return ok(res, ts=time.time())


@bp.route("/ml/strategies")
def ml_strategies():
    """Топ-стратегии по доходу на 1 млн ₽ с учётом ликвидности и комиссии.
    ignore_com=1 — без вычета комиссии (для сравнения «грязного» дохода)."""
    try:
        con = analytics_db.analytics_conn()
    except FileNotFoundError as e:
        return err(str(e), 500)
    interval = request.args.get("interval", "1d")
    ignore = request.args.get("ignore_com", "0") in ("1", "true", "yes")
    with con:
        res = analytics_db.ml_strategies(con, interval=interval, ignore_com=1 if ignore else 0)
    return ok(res, ts=time.time())


# ── Новостной конвейер: тексты → метрики влияния (-100..100) → серии ──

def _news_conn_or_err():
    try:
        return news_db.news_conn()
    except Exception as e:
        return None, err(str(e), 500)


@bp.route("/news/stats")
def news_stats():
    """Сводка по новостному конвейеру: источники, статьи, скоринг, последние сигналы."""
    try:
        conn = news_db.news_conn()
    except Exception as e:
        return err(str(e), 500)
    with conn:
        sources = news_db.list_sources(conn)
        n_art = conn.execute("SELECT COUNT(*) n FROM articles").fetchone()["n"]
        n_sc = conn.execute("SELECT COUNT(*) n FROM scores").fetchone()["n"]
        last = news_db.recent_score_rows(conn, 20)
    return ok({"sources": sources, "n_articles": n_art, "n_scores": n_sc,
               "last": last, "ts": time.time()})


@bp.route("/news/overview")
def news_overview():
    """Бегущая таблица новостей с метриками влияния + аналитика за период.
    Период в часах (по умолчанию 24 = сутки). Распределение влияния по
    семействам: потенциально влиятельные (Σ|score|·conf) и подтверждённый
    бэктестом spearman/hit_rate (если данные достаточны)."""
    try:
        conn = news_db.news_conn()
    except Exception as e:
        return err(str(e), 500)
    period_h = min(max(int(request.args.get("period", "24") or 24), 1), 24 * 30)
    limit = min(max(int(request.args.get("limit", "20") or 20), 5), 100)
    with conn:
        sources = news_db.list_sources(conn)
        n_art = conn.execute("SELECT COUNT(*) n FROM articles").fetchone()["n"]
        n_sc = conn.execute("SELECT COUNT(*) n FROM scores").fetchone()["n"]
        n_period = conn.execute(
            "SELECT COUNT(*) n FROM articles WHERE fetched >= datetime('now', '-' || ? || ' hours')",
            (period_h,)).fetchone()["n"]
        # бегущая таблица: последние limit статей + их счёты по семействам
        art_rows = [dict(r) for r in conn.execute(
            """SELECT a.id, a.published, a.fetched, a.title, a.url,
                      src.code AS source_code, src.name AS source_name
               FROM articles a JOIN sources src ON src.id = a.source_id
               ORDER BY COALESCE(NULLIF(a.published,''), a.fetched) DESC LIMIT ?""",
            (limit,))]
        feed = []
        for a in art_rows:
            sc = [dict(r) for r in conn.execute(
                """SELECT family, score, conf, basis, features FROM scores
                   WHERE article_id=? ORDER BY ABS(score) DESC""", (a["id"],))]
            top = sc[0] if sc else None
            feed.append({**a, "scores": sc, "top_score": top["score"] if top else None,
                         "top_family": top["family"] if top else None,
                         "top_conf": top["conf"] if top else None,
                         "n_scores": len(sc)})
        # новостей по часам за период
        hours = [dict(r) for r in conn.execute(
            """SELECT strftime('%Y-%m-%d %H:00', a.fetched) AS h, COUNT(*) n
               FROM articles a
               WHERE a.fetched >= datetime('now', '-' || ? || ' hours')
               GROUP BY h ORDER BY h""", (period_h,))]
        # распределение потенциальной влиятельности по семействам
        fam_rows = [dict(r) for r in conn.execute(
            """SELECT s.family, COUNT(*) n,
                      SUM(ABS(s.score)*s.conf) AS infl,
                      SUM(CASE WHEN ABS(s.score)>=50 THEN 1 ELSE 0 END) AS strong,
                      ROUND(AVG(s.conf),3) AS avg_conf
               FROM scores s JOIN articles a ON a.id=s.article_id
               WHERE a.fetched >= datetime('now', '-' || ? || ' hours')
               GROUP BY s.family ORDER BY infl DESC""", (period_h,))]
        # по источникам за период
        src_rows = [dict(r) for r in conn.execute(
            """SELECT src.code, COUNT(*) n FROM articles a
               JOIN sources src ON src.id=a.source_id
               WHERE a.fetched >= datetime('now', '-' || ? || ' hours')
               GROUP BY src.code ORDER BY n DESC""", (period_h,))]
    return ok({"sources": sources, "n_articles": n_art, "n_scores": n_sc,
               "n_period": n_period, "period_h": period_h, "feed": feed,
               "hours": hours, "families": fam_rows, "by_source": src_rows,
               "ts": time.time()})


@bp.route("/news/health")
def news_health():
    """Health-check метрики: количество собранных статей, ошибок, статусы источников."""
    try:
        import news_collector
        health = news_collector.get_health()
        with news_db.news_conn() as conn:
            sources = news_db.list_sources(conn)
            enabled = [s["code"] for s in sources if s.get("enabled", 1)]
        return ok({"health": health, "enabled_sources": enabled, "ts": time.time()})
    except Exception as e:
        return err(str(e), 500)


@bp.route("/news/found_hours")
def news_found_hours():
    """Сводка найденных статей по часам × источникам.
    Строки — час (YYYY-MM-DD HH:00), столбцы — источник, ячейка — число статей."""
    try:
        conn = news_db.news_conn()
    except Exception as e:
        return err(str(e), 500)
    days = min(int(request.args.get("days", "3") or 3), 30)
    with conn:
        rows = [dict(r) for r in conn.execute(
            """SELECT strftime('%Y-%m-%d %H:00', a.fetched) AS hour, s.code, COUNT(*) n
               FROM articles a JOIN sources s ON s.id = a.source_id
               WHERE a.fetched >= datetime('now', '-' || ? || ' days')
               GROUP BY hour, s.code ORDER BY hour, s.code""", (days,))]
        totals_src = [dict(r) for r in conn.execute(
            """SELECT s.code, COUNT(*) n
               FROM articles a JOIN sources s ON s.id = a.source_id
               WHERE a.fetched >= datetime('now', '-' || ? || ' days')
               GROUP BY s.code ORDER BY n DESC""", (days,))]
    # формируем матрицу hour → {src: n}
    matrix = {}
    hours = []
    src_order = []
    for r in rows:
        h = r["hour"]
        if h not in matrix:
            matrix[h] = {}
            hours.append(h)
        matrix[h][r["code"]] = r["n"]
        if r["code"] not in src_order:
            src_order.append(r["code"])
    return ok({"hours": hours, "sources": src_order, "matrix": matrix,
               "totals_by_source": totals_src, "days": days, "ts": time.time()})


@bp.route("/news/corpus")
def news_corpus():
    """Накопление корпуса: статьи по дням (получено/опубликовано), по источникам, по семействам."""
    try:
        conn = news_db.news_conn()
    except Exception as e:
        return err(str(e), 500)
    days = min(int(request.args.get("days", "60") or 60), 365)
    with conn:
        # 1) по дням получения (fetched) — кривая накопления
        fetched = [dict(r) for r in conn.execute(
            "SELECT date(fetched) d, COUNT(*) n FROM articles "
            "WHERE fetched >= date('now', '-' || ? || ' days') "
            "GROUP BY d ORDER BY d", (days,))]
        # 2) по дням публикации (published) — источники контента
        published = [dict(r) for r in conn.execute(
            "SELECT date(published) d, COUNT(*) n FROM articles "
            "WHERE published != '' AND published >= date('now', '-' || ? || ' days') "
            "GROUP BY d ORDER BY d", (days,))]
        # 3) по источникам (по дням получения)
        by_src = [dict(r) for r in conn.execute(
            """SELECT date(a.fetched) d, s.code, COUNT(*) n
               FROM articles a JOIN sources s ON s.id=a.source_id
               WHERE a.fetched >= date('now', '-' || ? || ' days')
               GROUP BY d, s.code ORDER BY d""", (days,))]
        # 4) покрытие по семействам (сколько статей имеют score по каждому семейству)
        fam_cov = [dict(r) for r in conn.execute(
            """SELECT family, COUNT(DISTINCT article_id) n, ROUND(AVG(ABS(score)),1) avg_abs,
                      ROUND(AVG(conf),3) avg_conf
               FROM scores GROUP BY family ORDER BY n DESC""")]
        # 5) статистика полноты текста
        tot = conn.execute("SELECT COUNT(*) n FROM articles").fetchone()["n"]
        with_text = conn.execute(
            "SELECT COUNT(*) n FROM articles WHERE LENGTH(text) > 100").fetchone()["n"]
        conf_buckets = [dict(r) for r in conn.execute(
            """SELECT CAST(conf*10 AS INT) AS bucket, COUNT(*) n
               FROM scores GROUP BY bucket ORDER BY bucket""")]
    return ok({"fetched": fetched, "published": published, "by_source": by_src,
               "family_coverage": fam_cov, "conf_buckets": conf_buckets,
               "total_articles": tot, "with_text": with_text,
               "days": days, "ts": time.time()})


@bp.route("/news/series")
def news_series():
    """Временной ряд агрегированных метрик влияния по дням/часам."""
    try:
        conn = news_db.news_conn()
    except Exception as e:
        return err(str(e), 500)
    interval = request.args.get("interval", "1d")
    days = int(request.args.get("days", "90") or 90)
    fams = request.args.get("families") or None
    families = fams.split(",") if fams else None
    with conn:
        res = news_db.score_series(conn, interval=interval, days=days, families=families)
    return ok(res, ts=time.time())


@bp.route("/news/articles")
def news_articles():
    """История текстов с рассчитанными метриками (фильтр по источнику)."""
    try:
        conn = news_db.news_conn()
    except Exception as e:
        return err(str(e), 500)
    src = request.args.get("source", "")
    fam = request.args.get("family", "")
    limit = min(int(request.args.get("limit", "100") or 100), 500)
    q = """SELECT a.id, a.published, a.title, a.url, s.family, s.score, s.conf, s.basis,
                  s.features, src.name AS source, src.code AS source_code
           FROM scores s JOIN articles a ON a.id = s.article_id
           JOIN sources src ON src.id = a.source_id WHERE 1=1"""
    params = []
    if src:
        q += " AND src.code=?"; params.append(src)
    if fam:
        q += " AND s.family=?"; params.append(fam)
    q += " ORDER BY a.published DESC, s.family LIMIT ?"; params.append(limit)
    rows = [dict(r) for r in conn.execute(q, params)]
    return ok({"articles": rows, "ts": time.time()})


@bp.route("/news/params", methods=["GET"])
def news_params_get():
    """Управляемые параметры анализа текстов (словарь весов, пороги, агрегация)."""
    try:
        conn = news_db.news_conn()
        with conn:
            p = news_db.load_params(conn, news_scorer.DEFAULT_PARAMS)
        return ok({"params": p, "ts": time.time()})
    except Exception as e:
        return err(str(e), 500)


@bp.route("/news/params", methods=["POST"])
def news_params_set():
    """Обновление параметров анализа. Принимает JSON, частичное обновление.
    Сохраняет в БД params. Не пересчитывает скоринг — для этого /news/rescore."""
    body = request.get_json(silent=True) or {}
    try:
        conn = news_db.news_conn()
        with conn:
            p = news_db.load_params(conn, news_scorer.DEFAULT_PARAMS)
            for k in ("half_life_hours", "min_conf", "agg", "norm"):
                if k in body and body[k] is not None:
                    try:
                        p[k] = float(body[k]) if k != "agg" else str(body[k])
                    except (TypeError, ValueError):
                        pass
            if "weights" in body and isinstance(body["weights"], dict):
                for c in ("monetary", "commodity", "geopolitics", "macro", "demand"):
                    if c in body["weights"]:
                        try:
                            p["weights"][c] = float(body["weights"][c])
                        except (TypeError, ValueError):
                            pass
            news_db.save_params(conn, p)
        news_scorer.set_params(p)
        return ok({"params": p, "saved": True, "ts": time.time()})
    except Exception as e:
        return err(str(e), 500)


@bp.route("/news/rescore", methods=["POST"])
def news_rescore():
    """Пересчёт метрик по всем статьям (после смены словаря/параметров)."""
    body = request.get_json(silent=True) or {}
    try:
        import news_collector
        conn = news_db.news_conn()
        with conn:
            counts = news_collector.rescore_all(conn, families=body.get("families"))
        return ok({"rescore": counts, "ts": time.time()})
    except Exception as e:
        return err(f"rescore failed: {e}", 500)


@bp.route("/news/collect", methods=["POST"])
def news_collect():
    """Запуск сбора новостей (вручную). sources — список кодов, default=all."""
    body = request.get_json(silent=True) or {}
    src = body.get("sources") or "all"
    try:
        import news_collector
        conn = news_db.news_conn()
        news_db.init_db()
        codes = [s["code"] for s in news_db.list_sources(conn)]
        if isinstance(src, list):
            codes = [c for c in codes if c in src]
        elif isinstance(src, str) and src != "all":
            codes = [c for c in codes if c == src]
        report = {}
        total = 0
        errors = 0
        for code in codes:
            try:
                n = news_collector.import_articles(conn, code, None, max_items=30)
                report[code] = n
                total += n if isinstance(n, int) else 0
            except Exception as e:
                report[code] = {"err": str(e)[:200]}
                errors += 1
        news_collector._record_stats("manual", total, errors)
        return ok({"report": report, "total": total, "errors": errors, "ts": time.time()})
    except Exception as e:
        return err(f"collect failed: {e}", 500)


@bp.route("/news/sources/update", methods=["POST"])
def news_sources_update():
    """Управление источниками: включение/отключение/вес.
    body: {"sources": [{"code": "rbc", "enabled": 0, "weight": 1.2}, ...]}"""
    body = request.get_json(silent=True) or {}
    updates = body.get("sources")
    if not isinstance(updates, list) or not updates:
        return err("expected sources[]", 400)
    try:
        conn = news_db.news_conn()
        with conn:
            for u in updates:
                if "code" not in u:
                    continue
                fields = {}
                if "enabled" in u:
                    fields["enabled"] = 1 if u["enabled"] else 0
                if "weight" in u:
                    try:
                        fields["weight"] = float(u["weight"])
                    except (TypeError, ValueError):
                        continue
                if fields:
                    news_db.upsert_source(conn, u["code"], fields)
        conn.close()
        return ok({"updated": [u.get("code") for u in updates], "ts": time.time()})
    except Exception as e:
        return err(str(e), 500)


@bp.route("/news/signatures/validate", methods=["GET"])
def news_signatures_validate():
    """Корреляция сигнатур с фактическими движениями цен по семействам.
    Сравнивает все подходы (lexicon/hybrid/tfidf) за горизонты 1/2/3/5 дней.
    Query: interval=1d."""
    interval = request.args.get("interval", "1d")
    horizons = [1, 2, 3, 5]
    try:
        import signature_validation as sv
        result = sv.compare_methods(interval=interval)
        return ok({"compare": result, "horizons": horizons, "ts": time.time()})
    except Exception as e:
        return err(str(e), 500)


@bp.route("/news/signatures/compare", methods=["GET"])
def news_signatures_compare():
    """Сравнение подходов к сигнатурам: TF-IDF vs Hybrid vs Lexicon.
    Возвращает: метрики по каждому подходу (conf, families, latency)."""
    try:
        import text_signature as ts
        texts = []
        conn = news_db.news_conn()
        with conn:
            rows = conn.execute("SELECT text, title FROM articles ORDER BY id DESC LIMIT 200").fetchall()
            texts = [r["text"] or r["title"] or "" for r in rows if r["text"] or r["title"]]
        if not texts:
            return ok({"compare": {}, "message": "no articles", "ts": time.time()})
        comparison = ts.compare_approaches(texts[:100])
        return ok({"compare": comparison, "n_articles": len(texts[:100]), "ts": time.time()})
    except Exception as e:
        return err(str(e), 500)


@bp.route("/news/signatures/transform", methods=["POST"])
def news_signatures_transform():
    """Преобразует текст в сигнатуру влияния по выбранному методу.
    body: {"text": "...", "method": "hybrid"}."""
    body = request.get_json(silent=True) or {}
    text = body.get("text", "")
    method = body.get("method", "hybrid")
    if not text:
        return err("text is required", 400)
    try:
        import text_signature as ts
        builder = ts.SignatureBuilder.create(method)
        if method != "lexicon":
            conn = news_db.news_conn()
            with conn:
                rows = conn.execute("SELECT text, title FROM articles").fetchall()
                texts = [r["text"] or r["title"] or "" for r in rows if r["text"] or r["title"]]
                if texts:
                    builder.fit(texts)
        result, confidence, features = builder.transform(text)
        return ok({"result": result, "confidence": confidence, "features": features, "method": method, "ts": time.time()})
    except Exception as e:
        return err(str(e), 500)


# ── ML-модель новостей: регрессия размера движения, подбор лагов ──
@bp.route("/news/ml/train", methods=["POST"])
def news_ml_train():
    """Обучает модель |return| по прямым новостям (fam_coef=1.0).
    body: {"min_conf": 0.0, "test_ratio": 0.25}."""
    body = request.get_json(silent=True) or {}
    min_conf = float(body.get("min_conf", 0.0))
    test_ratio = float(body.get("test_ratio", 0.25))
    try:
        import news_ml
        result = news_ml.train_model(min_conf=min_conf, test_ratio=test_ratio)
        return ok(result)
    except Exception as e:
        return err(str(e), 500)


@bp.route("/news/ml/predict", methods=["POST"])
def news_ml_predict():
    """Предсказывает оптимальный лаг и размер движения для текста.
    body: {"text": "...", "family": "GOLD", "source": "oilprice.com", "published": "2026-09-16 14:00"}."""
    body = request.get_json(silent=True) or {}
    text = body.get("text", "")
    family = body.get("family", "").upper()
    if not text or not family:
        return err("text and family are required", 400)
    try:
        import news_ml
        result = news_ml.predict_article(text, family,
                                         source=body.get("source", ""),
                                         published=body.get("published"))
        return ok(result)
    except Exception as e:
        return err(str(e), 500)


@bp.route("/news/ml/backtest", methods=["GET"])
def news_ml_backtest():
    """Бэктест модели с комиссиями Финам (1.2 ₽/контракт)."""
    try:
        import news_ml
        result = news_ml.backtest(contracts=int(request.args.get("contracts", 1)),
                                  min_conf=float(request.args.get("min_conf", 0.0)))
        return ok(result)
    except Exception as e:
        return err(str(e), 500)


@bp.route("/news/ml/status", methods=["GET"])
def news_ml_status():
    """Статус ML-модели новостей."""
    try:
        import news_ml
        return ok(news_ml.get_status())
    except Exception as e:
        return err(str(e), 500)


@bp.route("/news/signals/list")
def news_signals_list():
    """Список сгенерированных сигналов: статьи с оценками + движение цен.
    Query: period=24, min_conf=0.0, min_score=5, limit=50."""
    period_h = min(max(int(request.args.get("period", "24") or 24), 1), 24 * 30)
    min_conf = float(request.args.get("min_conf", "0.0") or 0.0)
    min_score = float(request.args.get("min_score", "5.0") or 5.0)
    limit = min(max(int(request.args.get("limit", "50") or 50), 5), 200)

    try:
        conn = news_db.news_conn()
    except Exception as e:
        return err(str(e), 500)

    # Загружаем 10min-бары по семействам (подвижные окна цен)
    import news_ml
    families = ["GOLD", "BRENT", "SILV", "COPPER", "NGAS", "PLATINUM_SPOT"]
    price_cache = {}
    try:
        pconn = news_ml._price_conn()
        for fam in families:
            try:
                raw = news_ml._family_series_10m(pconn, fam, limit=3000)
                price_cache[fam] = [dict(b) for b in raw if b.get("close")]
            except Exception:
                price_cache[fam] = []
    except Exception:
        pass

    with conn:
        rows = [dict(r) for r in conn.execute(
            """SELECT sc.id AS score_id, sc.family, sc.score, sc.conf, sc.basis,
                      a.id AS article_id, a.published, a.title, a.url, a.domain,
                      src.code AS source_code, src.name AS source_name
               FROM scores sc
               JOIN articles a ON a.id = sc.article_id
               JOIN sources src ON src.id = a.source_id
               WHERE ABS(sc.score) >= ? AND sc.conf >= ?
                 AND a.fetched >= datetime('now', '-' || ? || ' hours')
               ORDER BY a.published DESC LIMIT ?""",
            (min_score, min_conf, period_h, limit))]

    # Обогащаем движением цен
    for r in rows:
        fam = r["family"]
        pub = r["published"] or ""
        bars = price_cache.get(fam, [])
        bar_idx = None
        if bars and pub:
            bar_idx, _ = news_ml._find_bar_idx(bars, pub)

        price_at_pub = None
        moves = {}
        if bar_idx is not None and bars:
            price_at_pub = float(bars[bar_idx].get("close", 0))
            for label, lag_bars in [("2h", 12), ("4h", 24), ("8h", 48), ("24h", 144)]:
                fidx = bar_idx + lag_bars
                if fidx < len(bars):
                    close_fwd = float(bars[fidx].get("close", 0))
                    if price_at_pub > 0:
                        moves[label] = round((close_fwd - price_at_pub) / price_at_pub * 100, 4)
        r["price_at_pub"] = price_at_pub
        r["moves"] = moves
        # Направление сигнала
        if r["score"] > min_score:
            r["signal"] = "▲ LONG"
        elif r["score"] < -min_score:
            r["signal"] = "▼ SHORT"
        else:
            r["signal"] = "— NEUTRAL"

    return ok({"signals": rows, "period_h": period_h, "min_score": min_score,
               "n": len(rows), "ts": time.time()})