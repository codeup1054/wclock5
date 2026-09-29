# news_db.py — хранилище новостных текстов и рассчитанных метрик влияния.
# Пишет в news/ (Volume, rw) отдельно от read-only arbitrage.db.
# Схема: sources / articles / scores / params. Серии — агрегация поверх scores.
import os
import json
import sqlite3


def news_conn():
    p = os.environ.get("NEWS_DB", "")
    if not p:
        p = os.path.join(os.path.dirname(__file__), "news", "news.db")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    conn = sqlite3.connect(p)
    conn.row_factory = sqlite3.Row
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  url TEXT DEFAULT '',
  kind TEXT DEFAULT 'rss',          -- rss | api | tg
  lang TEXT DEFAULT 'ru',           -- ru | en
  families TEXT DEFAULT 'GOLD,SILV,COPPER,BRENT,NGAS',  -- целевые коммодити
  weight REAL DEFAULT 1.0,          -- вес источника при агрегации
  min_conf REAL DEFAULT 0.35,       -- порог уверенности для сигнала
  enabled INTEGER DEFAULT 1,
  note TEXT DEFAULT '',
  last_fetch TEXT DEFAULT '',
  items_total INTEGER DEFAULT 0,
  created TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  guid TEXT UNIQUE NOT NULL,        -- дедупликация (hash url/title)
  title TEXT NOT NULL,
  text TEXT DEFAULT '',
  url TEXT DEFAULT '',
  published TEXT DEFAULT '',        -- ISO время события
  fetched TEXT DEFAULT (datetime('now')),
  lang TEXT DEFAULT 'ru',
  domain TEXT DEFAULT '',           -- домен-первоисточник (для Google News агрегата)
  families TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  family TEXT NOT NULL,             -- GOLD/SILV/COPPER/BRENT/NGAS/...
  score REAL NOT NULL,              -- -100..100
  conf REAL NOT NULL,               -- 0..1 уверенность
  basis TEXT DEFAULT 'lex',         -- lex (словарь) | model | llm | hybrid
  features TEXT DEFAULT '',         -- JSON: top-термины и их веса
  created TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scores_art ON scores(article_id);
CREATE INDEX IF NOT EXISTS idx_scores_fam ON scores(family);
CREATE INDEX IF NOT EXISTS idx_articles_src ON articles(source_id);
CREATE INDEX IF NOT EXISTS idx_articles_pub ON articles(published);
CREATE TABLE IF NOT EXISTS params (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,               -- JSON: DEFAULT_PARAMS
  updated TEXT DEFAULT (datetime('now'))
);
"""


def init_db():
    conn = news_conn()
    with conn:
        conn.executescript(SCHEMA)
        try:
            conn.execute("ALTER TABLE articles ADD COLUMN domain TEXT DEFAULT ''")
        except Exception:
            pass  # колонка уже есть
        conn.executescript("""
        INSERT OR IGNORE INTO sources
          (code, name, url, kind, lang, note) VALUES
          ('interfax', 'Интерфакс / Финмаркет', 'https://www.finmarket.ru/rss/',
           'rss', 'ru', 'Фондовый рынок и товарные активы'),
          ('moex', 'Московская Биржа — новости', 'https://www.moex.com/ru/news/',
           'api', 'ru', 'Официальные сообщения биржи'),
          ('finam', 'Финам — экономические новости', 'https://www.finam.ru/analysis/feed/',
           'rss', 'ru', 'Обзоры и аналитика'),
          ('tass', 'ТАСС Экономика', 'https://tass.ru/rss/v2.xml',
           'rss', 'ru', 'Экономика и политика РФ'),
          ('kitco', 'Kitco News (gold/silver)', 'https://www.kitco.com/news/rss',
           'rss', 'en', 'Драгоценные металлы'),
          ('oilprice', 'OilPrice.com', 'https://oilprice.com/rss/main',
           'rss', 'en', 'Нефть, газ, энергетика'),
          ('investing', 'Investing.com Commodities', 'https://ru.investing.com/rss/news_25.rss',
           'rss', 'ru', 'Товарный рынок, котировки'),
          ('fomc', 'Federal Reserve Press', 'https://www.federalreserve.gov/feeds/press_all.xml',
           'rss', 'en', 'ФРС, ставка, QE — драйвер металлов/сырья'),
          ('tradingview', 'TradingView Ideas', 'https://www.tradingview.com/feed/?type=ideas',
           'api', 'ru', 'Идеи и аналитика по коммодити'),
          ('cbr', 'ЦБ РФ — пресс-релизы', 'https://www.cbr.ru/rss/',
           'rss', 'ru', 'Ключевая ставка, валютная политика (rss недоступен — кандидат)'),
          ('rbc', 'РБК Экономика', 'https://www.rbc.ru/rbcfreenews/',
           'rss', 'ru', 'Макро и рынки (rss закрыт — кандидат на парсер)'),
('eia', 'EIA Energy News', 'https://www.eia.gov/rss/energy_news.xml',
            'rss', 'en', 'Отчёты по запасам нефти/газа US (feed 404 — кандидат)'),
           ('cnbc', 'CNBC US Top News', 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
            'rss', 'en', 'Макро, ставки, сырьё'),
           ('marketwatch', 'MarketWatch Top Stories', 'https://feeds.content.dowjones.io/public/rss/mw_topstories',
            'rss', 'en', 'Рынки и commodities'),
           ('googlenews', 'Google News (commodity query)', 'https://news.google.com/rss/search?q=',
            'rss', 'en', 'Агрегатор: поиск по commodity-топикам, поддержка when (история)')
        """)
    return conn


# ── Источники ─────────────────────────────────────────
def list_sources(conn):
    return [dict(r) for r in conn.execute(
        "SELECT * FROM sources ORDER BY families, weight DESC, id")]


def get_source(conn, code):
    r = conn.execute("SELECT * FROM sources WHERE code=?", (code,)).fetchone()
    return dict(r) if r else None


def upsert_source(conn, code, fields):
    cur = conn.execute("SELECT id FROM sources WHERE code=?", (code,)).fetchone()
    if cur:
        sets = ", ".join(f"{k}=?" for k in fields)
        conn.execute(f"UPDATE sources SET {sets} WHERE code=?", (*fields.values(), code))
    else:
        cols = ", ".join(fields)
        marks = ", ".join("?" for _ in fields)
        conn.execute(f"INSERT INTO sources ({cols},code) VALUES ({marks},?)",
                     (*fields.values(), code))


def touch_source(conn, code, n_items):
    conn.execute("UPDATE sources SET last_fetch=datetime('now'), items_total=items_total+? "
                 "WHERE code=?", (n_items, code))


# ── Статьи и скоринг ─────────────────────────────────
def add_article(conn, source_id, guid, title, text, url, published, lang="ru", domain=""):
    cur = conn.execute(
        "INSERT OR IGNORE INTO articles (source_id,guid,title,text,url,published,lang,domain) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (source_id, guid, title, text or "", url or "", published or "", lang, domain or ""))
    if cur.lastrowid:
        return cur.lastrowid
    row = conn.execute("SELECT id FROM articles WHERE guid=?", (guid,)).fetchone()
    return row["id"] if row else None


def add_scores(conn, article_id, family_scores):
    """family_scores: list[(family, score, conf, basis, features)]"""
    with conn:
        for fam, sc, conf, basis, feats in family_scores:
            conn.execute(
                "INSERT OR REPLACE INTO scores (article_id,family,score,conf,basis,features) "
                "VALUES (?,?,?,?,?,?)",
                (article_id, fam, sc, conf, basis, json.dumps(feats or {}, ensure_ascii=False)))


def recent_score_rows(conn, limit=200):
    return [dict(r) for r in conn.execute("""
        SELECT a.id, a.published, a.title, a.url, s.family, s.score, s.conf, s.basis,
               s.features, src.name AS source, src.weight
        FROM scores s
        JOIN articles a ON a.id = s.article_id
        JOIN sources src ON src.id = a.source_id
        ORDER BY a.published DESC LIMIT ?""", (limit,))]


# ── Серии метрик (агрегация scores → временной ряд) ──
def score_series(conn, interval="1d", families=None, days=90, bucket_key=None):
    """Агрегирует score по статьям в ряды (date,family→{score,conf,count}).
    bucket_key: функция published-строки → ключ (date / date-hour)."""
    fams = families or ["GOLD", "SILV", "COPPER", "BRENT", "NGAS"]
    famq = ",".join("?" * len(fams))
    rows = conn.execute(f"""
        SELECT a.published, s.family, s.score, s.conf, src.weight
        FROM scores s
        JOIN articles a ON a.id = s.article_id
        JOIN sources src ON src.id = a.source_id
        WHERE s.family IN ({famq})
          AND a.published >= datetime('now', '-{int(days)} days')
        ORDER BY a.published""", fams).fetchall()
    out = {}
    datef = (lambda t: t[:10]) if interval == "1d" else (lambda t: t[:13])
    for r in rows:
        k = datef(r["published"] or "")
        fam = r["family"]
        o = out.setdefault(k, {}).setdefault(fam, {"n": 0, "sw": 0.0, "sc": 0.0})
        o["n"] += 1
        o["sw"] += (r["weight"] or 1.0) * (r["conf"] or 0)
        o["sc"] += (r["score"] or 0) * (r["weight"] or 1.0)
    series = []
    for k in sorted(out):
        srow = {}
        for fam, o in out[k].items():
            srow[fam] = {"score": round(o["sc"] / (o["sw"] or 1), 2),
                         "conf": round(min(o["sw"] / max(o["n"], 1), 1), 3),
                         "n": o["n"]}
        series.append({"dt": k, "families": srow})
    return {"interval": interval, "families": fams, "series": series}


# ── Параметры анализа (персистентны в БД) ──────────
def load_params(conn, defaults):
    """Возвращает сохранённые params или defaults, с merge на случай новых ключей."""
    r = conn.execute("SELECT data FROM params WHERE id=1").fetchone()
    if not r:
        return dict(json.loads(json.dumps(defaults)))
    try:
        saved = json.loads(r["data"])
    except Exception:
        return dict(json.loads(json.dumps(defaults)))
    out = dict(json.loads(json.dumps(defaults)))
    for k, v in saved.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k].update(v)
        else:
            out[k] = v
    return out


def save_params(conn, params):
    with conn:
        conn.execute(
            "INSERT OR REPLACE INTO params (id, data, updated) VALUES (1, ?, datetime('now'))",
            (json.dumps(params, ensure_ascii=False),))


def delete_scores(conn):
    """Очистка scores (перед пересчётом при смене словаря/параметров)."""
    with conn:
        conn.execute("DELETE FROM scores")