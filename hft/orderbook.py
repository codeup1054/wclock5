# orderbook.py — вкладка «Стакан» hft-app: поток T-Invest API (gRPC) → состояние + история.
# Порт 54.Hft/11.Orderbook. Подписка MarketDataStream (orderbook), REST-фоллбек GetOrderBook.
# Запускается фоновым потоком из app.py (см. __main__).
import http.client
import json
import os
import sqlite3
import ssl
import sys
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

TBANK_TOKEN = os.environ.get("TBANK_TOKEN", "")
TBANK_REST_HOST = os.environ.get("TBANK_REST_HOST", "invest-public-api.tbank.ru")
GRPC_HOST = os.environ.get("GRPC_HOST", "invest-public-api.tbank.ru:443")
GRPC_HOST_FALLBACK = os.environ.get("GRPC_HOST_FALLBACK", "invest-public-api.tinkoff.ru:443")
TICKER = os.environ.get("OB_TICKER", os.environ.get("TICKER", "TRUR"))
CLASS_CODE = os.environ.get("OB_CLASS_CODE", os.environ.get("CLASS_CODE", "SPBRU"))
DEPTH = int(os.environ.get("OB_DEPTH", os.environ.get("DEPTH", "20")))
HISTORY_HZ = float(os.environ.get("OB_HISTORY_HZ", os.environ.get("HISTORY_HZ", "1")))
HISTORY_MAXLEN = int(os.environ.get("OB_HISTORY_MAXLEN", os.environ.get("HISTORY_MAXLEN", "3600")))
REST_POLL_SEC = float(os.environ.get("OB_REST_POLL_SEC", os.environ.get("REST_POLL_SEC", "2")))
REST_POLL_CYCLES = 30

# ── Персистентное хранилище истории (SQLite) ─────────────────────────
# agg-снапшоты (1 Гц) + опционально полный стакан (уровни) + downsample 1 мин.
OB_DB_PATH = os.environ.get("OB_DB_PATH", str(HERE / "orderbook.db"))
OB_STORE_DB = os.environ.get("OB_STORE_DB", "1").strip().lower() not in ("0", "false", "no", "")
OB_STORE_LEVELS = os.environ.get("OB_STORE_LEVELS", "1").strip().lower() not in ("0", "false", "no", "")
OB_RETENTION_DAYS = float(os.environ.get("OB_RETENTION_DAYS", "30"))
OB_RETENTION_1M_DAYS = float(os.environ.get("OB_RETENTION_1M_DAYS", "365"))
OB_DB_FLUSH_SEC = float(os.environ.get("OB_DB_FLUSH_SEC", "5"))

FIND_ENDPOINT = "/rest/tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument"
ORDERBOOK_ENDPOINT = "/rest/tinkoff.public.invest.api.contract.v1.MarketDataService/GetOrderBook"
CANDLES_ENDPOINT = "/rest/tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles"

# Интервал графика → (enum API, макс. глубина окна в днях).
# Лимиты T-Invest: 1м→1д, 5–30м→7д, 1ч→90д, 1д→365д.
CANDLE_INTERVALS = {
    "1_MIN": ("CANDLE_INTERVAL_1_MIN", 1),
    "5_MIN": ("CANDLE_INTERVAL_5_MIN", 7),
    "15_MIN": ("CANDLE_INTERVAL_15_MIN", 7),
    "30_MIN": ("CANDLE_INTERVAL_30_MIN", 7),
    "HOUR": ("CANDLE_INTERVAL_HOUR", 90),
    "DAY": ("CANDLE_INTERVAL_DAY", 365),
}
_CANDLE_MAX_ROWS = 1500
_CANDLE_CACHE_SEC = float(os.environ.get("OB_CANDLE_CACHE_SEC", "15"))
_candles_cache = {}
_candles_cache_lock = threading.Lock()

_CA_FILES = ("russian_trusted_sub_ca.pem", "russian_trusted_root_ca.pem")
_SYSTEM_BUNDLES = (
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/cert.pem",
)

_roots_cache = None


def _windows_roots() -> bytes:
    import subprocess

    ps = (
        "Get-ChildItem Cert:\\LocalMachine\\Root | "
        "Where-Object { $_.HasPrivateKey -eq $false -and $_.NotAfter -gt (Get-Date) } | "
        "ForEach-Object { $b64 = [Convert]::ToBase64String($_.RawData); "
        "'-----BEGIN CERTIFICATE-----'; ($b64 -split '(.{64})' | Where-Object { $_ }); "
        "'-----END CERTIFICATE-----' }"
    )
    import shutil

    exe = shutil.which("powershell.exe") or shutil.which("pwsh.exe")
    if not exe:
        default = Path(os.environ.get("SystemRoot", "C:\\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
        exe = str(default) if default.exists() else None
    if not exe:
        return b""
    try:
        out = subprocess.run([exe, "-NoProfile", "-Command", ps],
                             capture_output=True, timeout=60).stdout
        return out.decode("utf-8", "replace").replace("\r", "").encode()
    except Exception:
        return b""


def root_certificates() -> bytes | None:
    """Системные корни + российские Trusted CA (tbank.ru). None → корни grpc по умолчанию."""
    global _roots_cache
    if _roots_cache is not None:
        return _roots_cache or None
    parts = []
    have_system = False
    for path in _SYSTEM_BUNDLES:
        try:
            if os.path.exists(path):
                parts.append(Path(path).read_bytes())
                have_system = True
                break
        except Exception:
            pass
    if not have_system:
        try:
            import certifi
            parts.append(Path(certifi.where()).read_bytes())
            have_system = True
        except Exception:
            pass
    if os.name == "nt" and not have_system:
        parts.append(_windows_roots())
    certs_dir = HERE / "certs"
    for name in _CA_FILES:
        f = certs_dir / name
        try:
            if f.exists():
                parts.append(f.read_bytes())
        except Exception:
            pass
    _roots_cache = b"\n".join(p for p in parts if p)
    return _roots_cache or None


def _rest_ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    roots = root_certificates()
    if roots:
        ctx.load_verify_locations(cadata=roots.decode("utf-8", "replace"))
    return ctx


def quotation_to_float(q) -> float:
    return q.units + q.nano / 1e9


def _timestamp_iso(ts) -> str | None:
    if ts is None or not getattr(ts, "seconds", None):
        return None
    return datetime.fromtimestamp(ts.seconds + ts.nanos / 1e9, tz=timezone.utc).isoformat(
        timespec="milliseconds")


def _iso_to_epoch(value):
    """ISO-время (в т.ч. с 'Z') → epoch-секунды (int) или None."""
    if not value:
        return None
    try:
        return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp())
    except (TypeError, ValueError):
        return None


class SnapshotStore:
    """SQLite-хранилище истории стакана.

    Таблицы:
    - ob_snapshots    — агрегат (mid/spread/best/Σqty), 1 строка/с, retention N дней;
    - ob_levels       — полный стакан (side/lvl/price/qty), опционально;
    - ob_snapshots_1m — downsample: OHLC mid + avg/max спред + avg Σqty по минутам.

    Запись батчится (OB_DB_FLUSH_SEC); удаление старого — раз в минуту.
    Все соединения на запись держит поток фида (check_same_thread=False),
    чтения (health/history) открывают отдельные короткие соединения.
    """

    def __init__(self, path=OB_DB_PATH, store_levels=OB_STORE_LEVELS,
                 retention_days=OB_RETENTION_DAYS, retention_1m_days=OB_RETENTION_1M_DAYS,
                 flush_sec=OB_DB_FLUSH_SEC):
        self.path = path
        self.store_levels = bool(store_levels)
        self.retention_days = float(retention_days)
        self.retention_1m_days = float(retention_1m_days)
        self.flush_sec = max(1.0, float(flush_sec))
        self._lock = threading.Lock()
        self._pending = []
        self._pending_lv = []
        self._pending_1m = []
        self._minute = None
        self._flushing = False
        self._last_flush = time.monotonic()
        self._last_maintain = 0
        self.rows_written = 0
        self.error = None
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
        except OSError:
            pass
        self._init_db()

    def _init_db(self):
        conn = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS ob_snapshots (
                ts INTEGER PRIMARY KEY,
                mid REAL, spread REAL,
                best_bid REAL, best_ask REAL,
                bid_qty REAL, ask_qty REAL
            );
            CREATE TABLE IF NOT EXISTS ob_levels (
                ts INTEGER, side INTEGER, lvl INTEGER,
                price REAL, qty REAL,
                PRIMARY KEY (ts, side, lvl)
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS ob_snapshots_1m (
                ts INTEGER PRIMARY KEY,
                open REAL, high REAL, low REAL, close REAL,
                avg_spread REAL, max_spread REAL,
                avg_bid_qty REAL, avg_ask_qty REAL,
                samples INTEGER
            );
            """
        )
        conn.commit()
        self._conn = conn

    def _read_conn(self):
        return sqlite3.connect(self.path, timeout=10)

    # ── запись ──────────────────────────────────────
    def ingest(self, snap, book):
        """Буферизует снапшот и (при необходимости) пишет батч в БД."""
        ts = _iso_to_epoch(snap.get("t")) or int(time.time())
        row = (ts, snap.get("mid"), snap.get("spread"),
               snap.get("best_bid"), snap.get("best_ask"),
               snap.get("bid_qty"), snap.get("ask_qty"))
        with self._lock:
            self._pending.append(row)
            if self.store_levels and book:
                self._pending_lv.append((ts, list(book.get("bids") or []), list(book.get("asks") or [])))
            self._update_minute_locked(ts, snap)
            due = (time.monotonic() - self._last_flush) >= self.flush_sec
        if due:
            self.flush()

    def _update_minute_locked(self, ts, snap):
        m = ts - (ts % 60)
        b = self._minute
        if b is None or b["ts"] != m:
            if b is not None:
                self._pending_1m.append(self._minute_row(b))
            b = {"ts": m, "open": None, "high": None, "low": None, "close": None,
                 "sp_sum": 0.0, "sp_max": None, "sp_n": 0,
                 "bq_sum": 0.0, "aq_sum": 0.0, "n": 0}
            self._minute = b
        mid = snap.get("mid")
        if mid is not None:
            if b["open"] is None:
                b["open"] = b["high"] = b["low"] = mid
            else:
                if mid > b["high"]:
                    b["high"] = mid
                if mid < b["low"]:
                    b["low"] = mid
            b["close"] = mid
        sp = snap.get("spread")
        if sp is not None:
            b["sp_sum"] += sp
            b["sp_n"] += 1
            b["sp_max"] = sp if b["sp_max"] is None else max(b["sp_max"], sp)
        b["bq_sum"] += snap.get("bid_qty") or 0.0
        b["aq_sum"] += snap.get("ask_qty") or 0.0
        b["n"] += 1

    @staticmethod
    def _minute_row(b):
        n = b["n"] or 1
        return (b["ts"], b["open"], b["high"], b["low"], b["close"],
                round(b["sp_sum"] / b["sp_n"], 6) if b["sp_n"] else None,
                b["sp_max"],
                round(b["bq_sum"] / n, 4), round(b["aq_sum"] / n, 4), b["n"])

    def flush(self):
        with self._lock:
            if self._flushing:
                return
            self._flushing = True
            rows, self._pending = self._pending, []
            lvs, self._pending_lv = self._pending_lv, []
            mins, self._pending_1m = self._pending_1m, []
            self._last_flush = time.monotonic()
        try:
            self._write(rows, lvs, mins)
        finally:
            with self._lock:
                self._flushing = False

    def _write(self, rows, lvs, mins):
        if not (rows or lvs or mins):
            return
        try:
            conn = self._conn
            with conn:
                if rows:
                    conn.executemany(
                        "INSERT OR REPLACE INTO ob_snapshots VALUES (?,?,?,?,?,?,?)", rows)
                if lvs:
                    flat = []
                    for ts, bids, asks in lvs:
                        for lvl, pq in enumerate(bids, 1):
                            flat.append((ts, 0, lvl, pq[0], pq[1]))
                        for lvl, pq in enumerate(asks, 1):
                            flat.append((ts, 1, lvl, pq[0], pq[1]))
                    conn.executemany(
                        "INSERT OR REPLACE INTO ob_levels VALUES (?,?,?,?,?)", flat)
                if mins:
                    conn.executemany(
                        "INSERT OR REPLACE INTO ob_snapshots_1m VALUES (?,?,?,?,?,?,?,?,?,?)", mins)
            with self._lock:
                self.rows_written += len(rows)
                self.error = None
            self._maybe_maintain()
        except Exception as exc:  # noqa: BLE001 — хранилище не должно ронять фид
            with self._lock:
                self.error = str(exc)[:300]

    def _maybe_maintain(self):
        now_ts = int(time.time())
        with self._lock:
            due = (now_ts - self._last_maintain) >= 60
            if due:
                self._last_maintain = now_ts
        if not due:
            return
        try:
            conn = self._conn
            with conn:
                if self.retention_days > 0:
                    cut = now_ts - int(self.retention_days * 86400)
                    conn.execute("DELETE FROM ob_snapshots WHERE ts < ?", (cut,))
                    conn.execute("DELETE FROM ob_levels WHERE ts < ?", (cut,))
                if self.retention_1m_days > 0:
                    cut2 = now_ts - int(self.retention_1m_days * 86400)
                    conn.execute("DELETE FROM ob_snapshots_1m WHERE ts < ?", (cut2,))
            try:
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except sqlite3.Error:
                pass
        except sqlite3.Error as exc:
            with self._lock:
                self.error = str(exc)[:300]

    # ── чтение (из потоков Flask) ───────────────────
    def recent_snapshots(self, limit=200):
        try:
            conn = self._read_conn()
            rows = conn.execute(
                "SELECT ts, mid, spread, best_bid, best_ask, bid_qty, ask_qty "
                "FROM ob_snapshots ORDER BY ts DESC LIMIT ?", (int(limit),)).fetchall()
            conn.close()
        except sqlite3.Error:
            return []
        out = []
        for ts, mid, spread, bb, ba, bq, aq in rows:
            out.append({
                "t": datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds"),
                "mid": mid, "spread": spread, "best_bid": bb, "best_ask": ba,
                "bid_qty": bq, "ask_qty": aq,
            })
        return out

    def stats(self):
        with self._lock:
            out = {
                "enabled": True,
                "path": self.path,
                "store_levels": self.store_levels,
                "retention_days": self.retention_days,
                "retention_1m_days": self.retention_1m_days,
                "written": self.rows_written,
                "pending": len(self._pending) + len(self._pending_1m),
                "error": self.error,
            }
        total = 0
        for suffix in ("", "-wal", "-shm"):
            try:
                p = self.path + suffix
                if os.path.exists(p):
                    total += os.path.getsize(p)
            except OSError:
                pass
        out["bytes"] = total
        try:
            conn = self._read_conn()
            row = conn.execute("SELECT MIN(ts), MAX(ts) FROM ob_snapshots").fetchone()
            conn.close()
            out["oldest"], out["newest"] = (row[0], row[1]) if row else (None, None)
        except sqlite3.Error:
            pass
        return out


class OrderBookState:
    def __init__(self, ticker=TICKER, depth=DEPTH, maxlen=HISTORY_MAXLEN, snapshot_hz=HISTORY_HZ):
        self.ticker = ticker
        self.depth = depth
        self.stopped = False
        self._lock = threading.Lock()
        self._snapshot_interval = 1.0 / snapshot_hz if snapshot_hz > 0 else 0.0
        self._next_snapshot = 0.0
        self._history = deque(maxlen=maxlen)
        self.bids = []
        self.asks = []
        self.book_time = None
        self.instrument_uid = None
        self.instrument = None
        self.updates = 0
        self.last_update = None
        self.connected = False
        self.transport = "init"
        self.status = "starting"
        self.error = None
        self.store = None
        if OB_STORE_DB:
            try:
                self.store = SnapshotStore()
            except Exception as exc:  # noqa: BLE001 — без БД фид продолжает работать
                print(f"[orderbook] хранилище недоступно: {exc}", flush=True)

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="milliseconds")

    def set_status(self, status):
        with self._lock:
            self.status = status
            self.error = None

    def set_transport(self, transport):
        with self._lock:
            self.transport = transport

    def set_connected(self, connected):
        with self._lock:
            self.connected = connected

    def set_instrument(self, instrument):
        with self._lock:
            self.instrument = instrument
            self.instrument_uid = instrument.get("uid")

    def set_error(self, error):
        with self._lock:
            self.error = str(error)[:500]

    def note_subscription(self, status_name):
        with self._lock:
            if status_name == "SUBSCRIPTION_STATUS_SUCCESS":
                self.status = "streaming"
                self.error = None
            else:
                self.error = f"subscription rejected: {status_name}"
                self.status = "error"

    def apply(self, bids, asks, book_time, uid):
        bids = sorted(bids, key=lambda x: x[0], reverse=True)
        asks = sorted(asks, key=lambda x: x[0])
        now = time.monotonic()
        snap = None
        book = None
        with self._lock:
            self.bids = bids
            self.asks = asks
            self.book_time = book_time
            self.instrument_uid = uid or self.instrument_uid
            self.updates += 1
            self.last_update = self._now_iso()
            self.connected = True
            if now >= self._next_snapshot:
                self._next_snapshot = now + self._snapshot_interval
                snap = self._make_snapshot_locked()
                self._history.append(snap)
                book = {"bids": list(bids), "asks": list(asks)}
        if snap is not None and self.store is not None:
            self.store.ingest(snap, book)

    def _make_snapshot_locked(self):
        bid_qty = sum(q for _, q in self.bids)
        ask_qty = sum(q for _, q in self.asks)
        best_bid = self.bids[0][0] if self.bids else None
        best_ask = self.asks[0][0] if self.asks else None
        mid = (best_bid + best_ask) / 2 if best_bid is not None and best_ask is not None else None
        spread = (best_ask - best_bid) if best_bid is not None and best_ask is not None else None
        return {
            "t": self.book_time or self.last_update,
            "mid": round(mid, 4) if mid is not None else None,
            "spread": round(spread, 4) if spread is not None else None,
            "best_bid": best_bid,
            "best_ask": best_ask,
            "bid_qty": bid_qty,
            "ask_qty": ask_qty,
        }

    def book(self):
        with self._lock:
            best_bid = self.bids[0][0] if self.bids else None
            best_ask = self.asks[0][0] if self.asks else None
            mid = (best_bid + best_ask) / 2 if best_bid is not None and best_ask is not None else None
            spread = (best_ask - best_bid) if best_bid is not None and best_ask is not None else None
            return {
                "ticker": self.ticker,
                "depth": self.depth,
                "ts": self.last_update,
                "book_time": self.book_time,
                "mid": round(mid, 4) if mid is not None else None,
                "spread": round(spread, 4) if spread is not None else None,
                "bids": [[p, q] for p, q in self.bids],
                "asks": [[p, q] for p, q in self.asks],
            }

    def history(self, limit=200):
        with self._lock:
            rows = list(self._history)[-limit:][::-1]
            store = self.store
        if store is None or len(rows) >= limit:
            return rows
        seen = set()
        for r in rows:
            e = _iso_to_epoch(r.get("t"))
            if e is not None:
                seen.add(e)
        for r in store.recent_snapshots(limit):
            e = _iso_to_epoch(r.get("t"))
            if e is not None and e in seen:
                continue
            rows.append(r)
            if len(rows) >= limit:
                break
        rows.sort(key=lambda r: _iso_to_epoch(r.get("t")) or 0, reverse=True)
        return rows[:limit]

    def health(self):
        with self._lock:
            data = {
                "ticker": self.ticker,
                "depth": self.depth,
                "status": self.status,
                "transport": self.transport,
                "connected": self.connected,
                "updates": self.updates,
                "last_update": self.last_update,
                "instrument": self.instrument,
                "error": self.error,
                "history_rows": len(self._history),
            }
            store = self.store
        data["db"] = store.stats() if store is not None else {"enabled": False}
        return data


def _rest_post(endpoint: str, payload: dict) -> dict:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {TBANK_TOKEN}",
    }
    conn = http.client.HTTPSConnection(TBANK_REST_HOST, context=_rest_ssl_context())
    try:
        conn.request("POST", endpoint, json.dumps(payload), headers)
        body = conn.getresponse().read().decode()
        return json.loads(body)
    finally:
        conn.close()


def resolve_instrument(query: str) -> dict:
    data = _rest_post(FIND_ENDPOINT, {"query": query})
    instruments = data.get("instruments") or []
    class_code = CLASS_CODE.strip()
    tickers = {query, query + "@"}
    exact = [i for i in instruments
             if i.get("ticker") in tickers and (not class_code or i.get("classCode") == class_code)]
    if not exact:
        found = ", ".join(sorted({f"{i.get('ticker')}/{i.get('classCode')}" for i in instruments})[:10])
        raise RuntimeError(f"ticker {query} not found (matches: {found or 'none'})")
    inst = next((i for i in exact if i.get("apiTradeAvailableFlag")), exact[0])
    return {
        "uid": inst.get("uid") or inst.get("figi"),
        "figi": inst.get("figi"),
        "name": inst.get("name"),
        "class_code": inst.get("classCode"),
        "instrument_type": inst.get("instrumentType"),
        "api_trade_available": inst.get("apiTradeAvailableFlag"),
    }


def _rest_quotation(value):
    return float(value.get("units", 0)) + float(value.get("nano", 0)) / 1e9


def _iso_utc(dt) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_epoch(value):
    """Приводит значение к epoch-секундам (int) или None (пусто/live/мусор)."""
    if value in (None, "", "live"):
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def get_candles(interval: str, hours: float = 24.0, from_ts=None, to_ts=None) -> dict:
    """Свечи инструмента из T-Invest REST (MarketDataService/GetCandles).

    Окно задаётся либо явными границами from_ts/to_ts (epoch-секунды; to_ts
    может быть "live" = текущий момент), либо глубиной hours от текущего
    момента. Итоговое окно клэмпится лимитом max_days интервала. Результат
    кешируется на _CANDLE_CACHE_SEC секунд.
    """
    key = (interval or "5_MIN").strip().upper()
    if key not in CANDLE_INTERVALS:
        raise ValueError(f"unknown interval '{interval}'")
    enum, max_days = CANDLE_INTERVALS[key]
    max_span = timedelta(days=max_days)

    now = datetime.now(timezone.utc)
    live = to_ts in (None, "", "live")
    if live:
        to_dt = now
    else:
        to_epoch = _parse_epoch(to_ts)
        to_dt = datetime.fromtimestamp(to_epoch, timezone.utc) if to_epoch is not None else now
        live = to_epoch is None

    from_epoch = _parse_epoch(from_ts)
    if from_epoch is None:
        try:
            hours = float(hours)
        except (TypeError, ValueError):
            hours = 24.0
        hours = max(0.25, min(hours, max_days * 24))
        from_dt = to_dt - timedelta(hours=hours)
    else:
        from_dt = datetime.fromtimestamp(from_epoch, timezone.utc)

    if to_dt - from_dt > max_span:
        from_dt = to_dt - max_span
    if from_dt >= to_dt:
        from_dt = to_dt - timedelta(minutes=30)

    cache_key = (key, int(from_dt.timestamp()), "live" if live else int(to_dt.timestamp()))
    now_mono = time.monotonic()
    with _candles_cache_lock:
        hit = _candles_cache.get(cache_key)
        if hit and (now_mono - hit[0]) < _CANDLE_CACHE_SEC:
            return hit[1]

    uid = feed.state.instrument_uid
    if not uid:
        uid = resolve_instrument(TICKER)["uid"]

    data = _rest_post(CANDLES_ENDPOINT, {
        "instrumentId": uid,
        "from": _iso_utc(from_dt),
        "to": _iso_utc(to_dt),
        "interval": enum,
    })
    if data.get("code") not in (None, 200) or "candles" not in data:
        raise RuntimeError(f"GetCandles: {data.get('message') or data}")

    rows = []
    for c in data.get("candles") or []:
        try:
            rows.append({
                "t": c.get("time"),
                "o": round(_rest_quotation(c["open"]), 6),
                "h": round(_rest_quotation(c["high"]), 6),
                "l": round(_rest_quotation(c["low"]), 6),
                "c": round(_rest_quotation(c["close"]), 6),
                "v": int(float(c.get("volume") or 0)),
                "done": bool(c.get("isComplete", True)),
            })
        except Exception:
            continue
    if len(rows) > _CANDLE_MAX_ROWS:
        rows = rows[-_CANDLE_MAX_ROWS:]

    result = {
        "ticker": TICKER,
        "interval": key,
        "interval_enum": enum,
        "from": _iso_utc(from_dt),
        "to": _iso_utc(to_dt),
        "live": live,
        "hours": round((to_dt - from_dt).total_seconds() / 3600.0, 3),
        "max_days": max_days,
        "count": len(rows),
        "rows": rows,
    }
    with _candles_cache_lock:
        _candles_cache[cache_key] = (now_mono, result)
    return result


def run_rest_poll(state: OrderBookState, uid: str, cycles=REST_POLL_CYCLES):
    for _ in range(cycles):
        if state.stopped:
            return
        data = _rest_post(ORDERBOOK_ENDPOINT, {"instrumentId": uid, "depth": state.depth})
        if "code" in data and data.get("code") != 200:
            raise RuntimeError(f"GetOrderBook: {data.get('message') or data}")
        bids = [(_rest_quotation(o["price"]), int(o["quantity"])) for o in data.get("bids") or []]
        asks = [(_rest_quotation(o["price"]), int(o["quantity"])) for o in data.get("asks") or []]
        state.apply(bids, asks, data.get("orderbookTs"), data.get("instrumentUid") or uid)
        state.set_status("rest polling")
        time.sleep(REST_POLL_SEC)


def _subscription_requests(state: OrderBookState, uid: str):
    from proto import marketdata_pb2 as md

    yield md.MarketDataRequest(
        subscribe_order_book_request=md.SubscribeOrderBookRequest(
            subscription_action=md.SUBSCRIPTION_ACTION_SUBSCRIBE,
            instruments=[md.OrderBookInstrument(instrument_id=uid, depth=state.depth)],
        )
    )
    while not state.stopped:
        time.sleep(1)


def run_stream(state: OrderBookState, uid: str):
    import grpc

    from proto import marketdata_pb2_grpc as md_grpc

    creds = grpc.ssl_channel_credentials(root_certificates=root_certificates())
    options = (
        ("grpc.keepalive_time_ms", 30_000),
        ("grpc.keepalive_timeout_ms", 10_000),
        ("grpc.keepalive_permit_without_calls", 1),
    )
    hosts = [GRPC_HOST]
    if GRPC_HOST_FALLBACK and GRPC_HOST_FALLBACK not in hosts:
        hosts.append(GRPC_HOST_FALLBACK)
    last_error = None
    for host in hosts:
        try:
            with grpc.secure_channel(host, creds, options=options) as channel:
                stub = md_grpc.MarketDataStreamServiceStub(channel)
                state.set_transport(f"grpc:{host}")
                state.set_status("connecting")
                metadata = (("authorization", f"Bearer {TBANK_TOKEN}"),)
                responses = stub.MarketDataStream(_subscription_requests(state, uid), metadata=metadata)
                state.set_connected(True)
                state.set_status("waiting data")
                for resp in responses:
                    _handle_response(state, resp)
            return
        except Exception as exc:
            last_error = exc
            state.set_connected(False)
    raise last_error


def _handle_response(state: OrderBookState, resp):
    from proto import marketdata_pb2 as md

    kind = resp.WhichOneof("payload")
    if kind == "orderbook":
        ob = resp.orderbook
        bids = [(quotation_to_float(o.price), int(o.quantity)) for o in ob.bids]
        asks = [(quotation_to_float(o.price), int(o.quantity)) for o in ob.asks]
        state.apply(bids, asks, _timestamp_iso(ob.time), ob.instrument_uid)
        state.set_status("streaming")
    elif kind == "subscribe_order_book_response":
        for sub in resp.subscribe_order_book_response.order_book_subscriptions:
            state.note_subscription(md.SubscriptionStatus.Name(sub.subscription_status))
    elif kind == "ping":
        state.set_connected(True)


class OrderBookFeed:
    """Фоновый поток: держит соединение T-Invest и обновляет OrderBookState."""

    def __init__(self):
        self.state = OrderBookState()
        self._thread = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="orderbook-feed", daemon=True)
        self._thread.start()
        print(f"[orderbook] воркер запущен: {self.state.ticker} ({CLASS_CODE}), depth={self.state.depth}", flush=True)

    def _run(self):
        state = self.state
        if not TBANK_TOKEN:
            state.set_status("error")
            state.set_error("TBANK_TOKEN не задан в окружении контейнера")
            print("[orderbook] TBANK_TOKEN пуст — поток не запущен", flush=True)
            return
        state.set_status("resolving instrument")
        try:
            instrument = resolve_instrument(TICKER)
        except Exception as exc:
            state.set_status("error")
            state.set_error(f"resolve: {exc}")
            print(f"[orderbook] resolve error: {exc}", flush=True)
            return
        state.set_instrument(instrument)
        state.set_status("connecting")
        fails = 0
        while not state.stopped:
            if fails >= 3:
                try:
                    run_rest_poll(state, instrument["uid"])
                    fails = 0
                except Exception as exc:
                    fails += 1
                    state.set_error(f"rest: {exc}")
                    time.sleep(min(2 ** fails, 15))
                continue
            try:
                run_stream(state, instrument["uid"])
                time.sleep(1)
            except Exception as exc:
                fails += 1
                state.set_connected(False)
                state.set_error(f"grpc: {exc}")
                time.sleep(min(2 ** fails, 15))


feed = OrderBookFeed()
