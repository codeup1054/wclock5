"""Журнал алертов: SQLite (анализ) + CSV (быстрый просмотр) + Telegram.

Префиксы: [SK_DESK] для десктопа, [TAB] для алертов планшета.
При недоступности Telegram алерт остаётся в очереди (sent=0, attempts++).
"""
from __future__ import annotations

import csv
import json
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

LEVELS = ("info", "warn", "alert")


class AlertManager:
    def __init__(self, logs_dir: str | Path, cfg: dict):
        self.dir = Path(logs_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.dir / "alerts.db"
        self.csv_path = self.dir / "alerts.csv"
        self.cfg = cfg
        self.conn = sqlite3.connect(self.db_path, timeout=10)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                bucket INTEGER NOT NULL,
                level TEXT NOT NULL,
                code TEXT NOT NULL,
                message TEXT NOT NULL,
                details TEXT,
                origin TEXT NOT NULL DEFAULT 'desk',
                sent INTEGER NOT NULL DEFAULT 0,
                sent_ts INTEGER,
                attempts INTEGER NOT NULL DEFAULT 0,
                UNIQUE(code, bucket, origin)
            )
        """)
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts)")
        self.conn.commit()
        self._csv_header()

    # ------------------------------------------------------------- emit
    def emit(self, level: str, code: str, message: str, details=None,
             origin: str = "desk", dedupe_sec: int = 600, ts: int | None = None) -> bool:
        level = level if level in LEVELS else "info"
        ts = ts if ts is not None else int(time.time() * 1000)
        bucket = ts // max(1, dedupe_sec) // 1000
        try:
            cur = self.conn.execute(
                "INSERT OR IGNORE INTO alerts(ts, bucket, level, code, message, details, origin) "
                "VALUES (?,?,?,?,?,?,?)",
                (ts, bucket, level, code, message,
                 json.dumps(details, ensure_ascii=False) if details else None, origin))
            if cur.rowcount == 0:
                return False
            self.conn.commit()
        except Exception:
            return False
        self._append_csv(ts, level, code, message, origin)
        return True

    def _csv_header(self) -> None:
        if not self.csv_path.exists():
            with self.csv_path.open("w", newline="", encoding="utf-8") as f:
                csv.writer(f).writerow(
                    ["ts", "datetime", "level", "code", "origin", "message"])

    def _append_csv(self, ts: int, level: str, code: str, message: str, origin: str) -> None:
        try:
            with self.csv_path.open("a", newline="", encoding="utf-8") as f:
                csv.writer(f).writerow([
                    ts,
                    time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts / 1000)),
                    level, code, origin, message])
        except Exception:
            pass

    # --------------------------------------------------------- telegram
    def flush_telegram(self, limit: int = 20) -> int:
        token = (self.cfg.get("telegramToken") or "").strip()
        chat = (self.cfg.get("telegramChatId") or "").strip()
        if not token or not chat or not self.cfg.get("telegramEnabled", True):
            return 0
        levels = self.cfg.get("telegramLevels", ["warn", "alert"])
        rows = self.conn.execute(
            "SELECT id, level, code, message, origin FROM alerts "
            "WHERE sent=0 AND attempts<10 AND level IN (%s) "
            "ORDER BY ts LIMIT ?" % ",".join("?" * len(levels)),
            (*levels, limit)).fetchall()
        sent = 0
        for aid, level, code, message, origin in rows:
            text = self._format(level, code, message, origin)
            ok = self._send(token, chat, text)
            now = int(time.time() * 1000)
            if ok:
                self.conn.execute("UPDATE alerts SET sent=1, sent_ts=? WHERE id=?", (now, aid))
                sent += 1
            else:
                self.conn.execute(
                    "UPDATE alerts SET attempts=attempts+1, "
                    "sent=CASE WHEN attempts+1>=10 THEN -2 ELSE 0 END WHERE id=?", (aid,))
            self.conn.commit()
        return sent

    def _format(self, level: str, code: str, message: str, origin: str) -> str:
        prefix = (self.cfg.get("telegramPrefixTablet", "[TAB]")
                  if origin == "tablet"
                  else self.cfg.get("telegramPrefixDesktop", "[SK_DESK]"))
        return f"{prefix} {level.upper()} {code}: {message}"

    def _send(self, token: str, chat: str, text: str) -> bool:
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        data = urllib.parse.urlencode({"chat_id": chat, "text": text}).encode()
        proxy = (self.cfg.get("telegramProxy") or "").strip()
        handlers = [urllib.request.ProxyHandler(
            {"http": proxy, "https": proxy})] if proxy else []
        opener = urllib.request.build_opener(*handlers)
        try:
            with opener.open(urllib.request.Request(url, data=data), timeout=8) as r:
                return r.status == 200
        except (urllib.error.URLError, urllib.error.HTTPError, OSError):
            return False

    # ------------------------------------------------------------ read
    def recent(self, limit: int = 50) -> list[dict]:
        rows = self.conn.execute(
            "SELECT ts, level, code, origin, message FROM alerts "
            "ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
        return [{"ts": r[0], "level": r[1], "code": r[2],
                 "origin": r[3], "message": r[4]} for r in rows]

    def unsent_count(self) -> int:
        row = self.conn.execute("SELECT COUNT(*) FROM alerts WHERE sent=0").fetchone()
        return int(row[0] or 0)

    def export_csv(self) -> Path:
        rows = self.conn.execute(
            "SELECT ts, level, code, origin, message FROM alerts ORDER BY ts").fetchall()
        with self.csv_path.open("w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["ts", "datetime", "level", "code", "origin", "message"])
            for ts, level, code, origin, message in rows:
                w.writerow([ts,
                            time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts / 1000)),
                            level, code, origin, message])
        return self.csv_path

    def close(self) -> None:
        try:
            self.conn.close()
        except Exception:
            pass
