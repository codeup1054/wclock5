# news_collector.py — регулярный сбор новостей из источников, дедуп, скоринг.
# Запуск: python news_collector.py  (сбор всех включённых источников)
#         python news_collector.py --source rbc --days 3  (принудительный/бэкфилл)
#         python news_collector.py --score-only            (пересчитать метрики по всем статьям)
import argparse
import hashlib
import re
import time
import os
import sys
import socket
import urllib.parse
import urllib.error
import xml.etree.ElementTree as ET
from datetime import datetime
import logging
from logging.handlers import RotatingFileHandler

sys.path.insert(0, os.path.dirname(__file__))

import news_db
import news_scorer

socket.setdefaulttimeout(15)
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " \
     "Chrome/126.0 Safari/537.36"

# ── Логирование (файл + stdout, rotation) ───────────────────────────
def _get_logger():
    lg = logging.getLogger("news_collector")
    if lg.handlers:
        return lg
    lg.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    lg.addHandler(sh)
    log_dir = os.environ.get("NEWS_LOG_DIR", "")
    if log_dir:
        os.makedirs(log_dir, exist_ok=True)
        fh = RotatingFileHandler(os.path.join(log_dir, "news_collector.log"),
                                 maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
        fh.setFormatter(fmt)
        lg.addHandler(fh)
    return lg


LOG = _get_logger()

# ── Health-check метрики ──────────────────────────────────────────
COLLECT_STATS = {"total_articles": 0, "total_errors": 0, "sources": {}, "runs": []}
MAX_RUNS_LOG = 50


def _record_stats(source, articles, errors):
    COLLECT_STATS["total_articles"] += articles
    COLLECT_STATS["total_errors"] += errors
    if source not in COLLECT_STATS["sources"]:
        COLLECT_STATS["sources"][source] = {"articles": 0, "errors": 0, "last_run": ""}
    COLLECT_STATS["sources"][source]["articles"] += articles
    COLLECT_STATS["sources"][source]["errors"] += errors
    COLLECT_STATS["sources"][source]["last_run"] = datetime.now().isoformat()


def _record_run(ts, found, relevant, added, errors, sources=None):
    """Записывает один проход сбора в лог runs."""
    COLLECT_STATS["runs"].append({
        "time": ts,
        "found": found,
        "relevant": relevant,
        "added": added,
        "errors": errors,
        "sources": sources or {}
    })
    if len(COLLECT_STATS["runs"]) > MAX_RUNS_LOG:
        COLLECT_STATS["runs"] = COLLECT_STATS["runs"][-MAX_RUNS_LOG:]


def get_health():
    return COLLECT_STATS


# ── Retry логика ─────────────────────────────────────────────────
MAX_RETRIES = 3
RETRY_DELAY = 2  # секунды (базовая задержка)
RETRY_BACKOFF = 2  # множитель экспоненциальной задержки


def _http_get(url, timeout=15, retries=MAX_RETRIES):
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                                "Accept": "*/*",
                                                "Accept-Language": "ru,en;q=0.8"})
    last_error = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            last_error = e
            if e.code in (403, 404, 429):
                print(f"  [err HTTP] {url}: {e} (attempt {attempt + 1}/{retries})")
                if attempt < retries - 1:
                    delay = RETRY_DELAY * (RETRY_BACKOFF ** attempt)
                    time.sleep(delay)
            else:
                break
        except urllib.error.URLError as e:
            last_error = e
            print(f"  [err URL] {url}: {e} (attempt {attempt + 1}/{retries})")
            if attempt < retries - 1:
                delay = RETRY_DELAY * (RETRY_BACKOFF ** attempt)
                time.sleep(delay)
        except Exception as e:
            last_error = e
            print(f"  [err] {url}: {e} (attempt {attempt + 1}/{retries})")
            if attempt < retries - 1:
                delay = RETRY_DELAY * (RETRY_BACKOFF ** attempt)
                time.sleep(delay)
    raise last_error


def _norm_guid(url, title):
    base = url or (title or "")
    return hashlib.sha1(base.encode("utf-8", "ignore")).hexdigest()


def _strip_html(t):
    if not t:
        return ""
    t = re.sub(r"<[^>]+>", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def _parse_date(s):
    if not s:
        return ""
    for fmt in ("%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z",
                "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%dT%H:%M:%S", "%d.%m.%Y %H:%M"):
        try:
            return time.strftime("%Y-%m-%d %H:%M:%S",
                                 time.localtime(time.mktime(time.strptime(s, fmt))))
        except (ValueError, OSError, OverflowError):
            continue
    return ""


MIN_TITLE_LEN = 12
MAX_TITLE_LEN = 300


def _is_commodity_relevant(title, text):
    blob = (title + " " + text).lower()
    fams = list(news_scorer.FAMILY_MARKERS)
    return any(news_scorer._fam_match(blob, f) for f in fams) or \
        any(re.search(r"\b" + t + r"\b", blob, re.I) for t in news_scorer.GLOBAL_DRIVERS)


def collect_rss(conn, url, max_items=30):
    """Парсит RSS/Atom, возвращает статьи [(guid, title, text, url, published[, domain])].
    domain извлекается из тега <source url> (Google News)."""
    try:
        data = _http_get(url)
    except Exception as e:
        print(f"  [err HTTP] {url}: {e}")
        return []
    items = []
    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        print(f"  [err XML] {url}: {e}")
        return []
    for item in root.iter():
        if item.tag.split("}")[-1].lower() in ("item", "entry"):
            t = {}
            domain = ""
            for ch in item:
                tag = ch.tag.split("}")[-1].lower()
                if tag in ("title", "link", "description", "guid", "pubdate", "published", "updated", "summary"):
                    if tag == "link" and ch.get("href"):
                        t["link"] = ch.get("href")
                    else:
                        t[tag] = (ch.text or "").strip()
                elif tag == "source":
                    # Google News: <source url="https://kitco.com">Kitco News</source>
                    src_url = ch.get("url") or ""
                    if "google" not in src_url:
                        m = re.search(r"https?://([^/\s]+)", src_url, re.I)
                        if m:
                            domain = m.group(1).lower()
                        else:
                            domain = (ch.text or "").strip().lower()
            title = _strip_html(t.get("title") or "")
            link = t.get("link") or ""
            desc = t.get("description") or t.get("summary") or ""
            pub = _parse_date(t.get("pubdate") or t.get("published") or t.get("updated") or "")
            if len(title) < MIN_TITLE_LEN:
                continue
            items.append((_norm_guid(link, title), title, _strip_html(desc), link, pub, domain))
    return items[:max_items]


def collect_moex(conn, max_items=30):
    """Мосбиржа: новости из публичного RSS (через iss/экспорт)."""
    # Официальный RSS Мосбиржи недоступен; пробуем публичную ленту новостей.
    url = "https://www.moex.com/ru/news/feed/atom"
    try:
        items = collect_rss(conn, url, max_items)
        if items:
            return items
    except Exception:
        pass
    print("  [info] MOEX feed пуст/недоступен — пропущен")
    return []


def collect_foman_feed(conn, max_items=30):
    """Investing.com RSS (commodities-канал)."""
    return collect_rss(conn, "https://ru.investing.com/rss/news_25.rss", max_items) or \
        collect_rss(conn, "https://www.investing.com/rss/news_25.rss", max_items)


# ── Google News RSS: агрегатор с историей (when) и multi-language ──
import urllib.parse as _up

GOOGLE_NEWS_QUERIES = [
    # (query, lang, country)  — commodity-топики, hl=ru/en
    ("oil price OR crude oil OR brent", "en", "US"),
    ("gold price OR gold market", "en", "US"),
    ("silver OR copper OR platinum price", "en", "US"),
    ("natural gas price OR ngas", "en", "US"),
    ("opec OR oil supply OR crude inventories", "en", "US"),
    ("fed rate OR interest rate hike OR rate cut", "en", "US"),
    ("нефть OR бренд OR золото OR серебро", "ru", "RU"),
    ("природный газ OR медь OR платина OR цена на нефть", "ru", "RU"),
    ("ставка ФРС OR ключевая ставка OR санкции", "ru", "RU"),
]


def collect_googlenews(conn, max_items=40, days=7):
    """Собирает заголовки коммодити-топиков из Google News за последние N дней.
    Возвращает [(guid, title, text, url, published, domain)]. Домен-первоисточник
    берётся из <source url> (для подбора лага по источнику)."""
    out = []
    seen = set()
    per_q = max(3, max_items // len(GOOGLE_NEWS_QUERIES) or 5)
    for query, hl, gl in GOOGLE_NEWS_QUERIES:
        params = {"q": query, "hl": hl, "gl": gl,
                  "ceid": f"{gl}:{hl}", "when": f"{int(days)}d"}
        url = "https://news.google.com/rss/search?" + _up.urlencode(params)
        try:
            items = collect_rss(conn, url, per_q * 3)
        except Exception as e:
            print(f"  [err GN] {query[:40]}: {e}")
            continue
        for row in items:
            guid, title, text = row[0], row[1], row[2]
            link, pub = row[3], row[4]
            domain = row[5] if len(row) > 5 else ""
            if link in seen or guid in seen:
                continue
            seen.add(guid)
            seen.add(link)
            out.append((guid, title, text, link, pub, domain))
            if len(out) >= max_items:
                return out
    return out


COLLECTORS = {
    "interfax": ("rss", lambda c, m: collect_rss(c, "https://www.finmarket.ru/rss/", m)),
    "finam": ("rss", lambda c, m: collect_rss(c, "https://www.finam.ru/analysis/feed/", m)),
    "tass": ("rss", lambda c, m: collect_rss(c, "https://tass.ru/rss/v2.xml", m)),
    "fomc": ("rss", lambda c, m: collect_rss(c, "https://www.federalreserve.gov/feeds/press_all.xml", m)),
    "kitco": ("rss", lambda c, m: collect_rss(c, "https://www.kitco.com/news/rss", m)),
    "oilprice": ("rss", lambda c, m: collect_rss(c, "https://oilprice.com/rss/main", m)),
    "investing": ("api", collect_foman_feed),
    "moex": ("api", collect_moex),
    "cnbc": ("rss", lambda c, m: collect_rss(c, "https://www.cnbc.com/id/100003114/device/rss/rss.html", m)),
    "marketwatch": ("rss", lambda c, m: collect_rss(c, "https://feeds.content.dowjones.io/public/rss/mw_topstories", m)),
    "googlenews": ("api", collect_googlenews),
    # tg/api-источники — подключить позднее (news_bot, парсеры TG); cbr/eia/rbc — 404/403, кандидаты
}


def import_articles(conn, source_code, url_or_fn, max_items=30, dry_run=False,
                    run_score=True, collect=None):
    """Собирает статьи источника, добавляет в БД, скоринг по умолчанию.
    Возвращает dict {found, relevant, added}."""
    _load_persisted_params(conn)
    src = news_db.get_source(conn, source_code)
    if not src or not src["enabled"]:
        return {"found": 0, "relevant": 0, "added": 0}
    if collect is None:
        _kind, fn = COLLECTORS.get(source_code, (None, None))
        if fn is None:
            print(f"  [err] неизвестный источник {source_code}")
            return {"found": 0, "relevant": 0, "added": 0}
        items = fn(conn, max_items) if url_or_fn is None else collect_rss(conn, url_or_fn, max_items)
    else:
        items = collect(conn, max_items)
    found = len(items)
    LOG.info("%s: получено %d статей", source_code, found)
    relevant = 0
    added = 0
    fams = [f.strip() for f in src["families"].split(",") if f.strip()]
    if not fams:
        fams = list(news_scorer.FAMILY_MARKERS)
    for row in items:
        guid, title, text, url, pub = row[0], row[1], row[2], row[3], row[4]
        domain = row[5] if len(row) > 5 else ""
        if not _is_commodity_relevant(title, text):
            continue
        relevant += 1
        if dry_run:
            added += 1
            continue
        aid = news_db.add_article(conn, src["id"], guid, title, text, url, pub, src["lang"], domain)
        if aid:
            scored = news_scorer.score_text_multi(text or title, fams)
            if scored:
                news_db.add_scores(conn, aid, scored)
            added += 1
    if not dry_run:
        news_db.touch_source(conn, source_code, added)
        conn.commit()
    print(f"  {source_code}: найдено {found}, релевантных {relevant}, добавлено {added}")
    LOG.info("%s: найдено %d, релевантных %d, добавлено %d", source_code, found, relevant, added)
    return {"found": found, "relevant": relevant, "added": added}


def _load_persisted_params(conn):
    """Подтягивает сохранённые параметры из БД в глобальные скорера."""
    try:
        p = news_db.load_params(conn, news_scorer.DEFAULT_PARAMS)
        news_scorer.set_params(p)
    except Exception as e:
        print(f"  [warn] params: {e}")
    return news_scorer.DEFAULT_PARAMS


def score_all(conn, families=None, limit=None):
    """Скоринг статей без оценок (дозаполнение после сбора)."""
    _load_persisted_params(conn)
    rows = conn.execute("SELECT a.id, a.text, a.title FROM articles a "
                        "WHERE a.id NOT IN (SELECT DISTINCT article_id FROM scores) "
                        "ORDER BY a.id" + (" LIMIT ?" if limit else "")).fetchall() \
        if limit is None else \
        conn.execute("SELECT a.id, a.text, a.title FROM articles a "
                     "WHERE a.id NOT IN (SELECT DISTINCT article_id FROM scores) "
                     "ORDER BY a.id LIMIT ?", (limit,)).fetchall()
    fams = families or list(news_scorer.FAMILY_MARKERS)
    n = 0
    for r in rows:
        scored = news_scorer.score_text_multi(r["text"] or r["title"], fams)
        if scored:
            news_db.add_scores(conn, r["id"], scored)
            n += 1
    conn.commit()
    print(f"  score_all: распознано {n} статей")
    return n


def rescore_all(conn, families=None):
    """Полный пересчёт: очищает scores и пересчитывает по всем статьям
    (после смены словаря/параметров). Возвращает {scored, articles}."""
    _load_persisted_params(conn)
    fams = families or list(news_scorer.FAMILY_MARKERS)
    articles = conn.execute("SELECT id, text, title FROM articles ORDER BY id").fetchall()
    news_db.delete_scores(conn)
    n = 0
    for r in articles:
        scored = news_scorer.score_text_multi(r["text"] or r["title"], fams)
        if scored:
            news_db.add_scores(conn, r["id"], scored)
            n += 1
    conn.commit()
    print(f"  rescore_all: пересчитано {n} из {len(articles)} статей")
    return {"scored": n, "articles": len(articles)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="all")
    ap.add_argument("--max-items", type=int, default=30)
    ap.add_argument("--days", type=int, default=2, help="глубина бэкфилла (не используется напрямую)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--score-only", action="store_true")
    args = ap.parse_args()

    conn = news_db.init_db()
    if args.score_only:
        score_all(conn, limit=500)
        return

    sources = news_db.list_sources(conn)
    codes = [s["code"] for s in sources if s["kind"] in ("rss", "api")]
    if args.source != "all":
        codes = [c for c in codes if c == args.source or args.source in c]
    total = 0
    for code in codes:
        r = import_articles(conn, code, None, args.max_items, dry_run=args.dry_run)
        total += r["added"]
    print(f"ИТОГО добавлено: {total}")


if __name__ == "__main__":
    main()