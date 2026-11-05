"""Самопроверка десктоп-синхронизации на mock-планшете.

Запуск: python -m parsers.invest.desktop_sync.selftest
"""
from __future__ import annotations

import json
import socket
import sqlite3
import tempfile
import time
from pathlib import Path

from .mock_tablet import serve
from .sync import SyncRunner


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def make_hot_db(path: Path) -> None:
    c = sqlite3.connect(path)
    c.executescript("""
        CREATE TABLE portfolio_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            total_value REAL NOT NULL,
            source TEXT DEFAULT 'tinkoff',
            ts_epoch INTEGER
        );
        CREATE TABLE invest_buckets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            ts_epoch INTEGER NOT NULL,
            source TEXT NOT NULL DEFAULT 'tinkoff',
            res TEXT NOT NULL DEFAULT 'min',
            open REAL, high REAL, low REAL, close REAL,
            volume INTEGER DEFAULT 0,
            tgld_value REAL, tgld_total REAL, tmon_value REAL, lqdt_value REAL,
            UNIQUE(ts_epoch, source, res)
        );
    """)
    c.commit()
    c.close()


def make_cfg(tmp: Path, port: int) -> dict:
    hot = tmp / "hot.db"
    make_hot_db(hot)
    return {
        "host": "127.0.0.1", "port": port, "timeoutSec": 3, "retries": 2,
        "autoStart": False, "syncMinutes": 10,
        "archiveDir": str(tmp / "data"), "logsDir": str(tmp / "logs"),
        "hotDbPath": str(hot),
        "maxTabletKb": 200, "maxArchiveMb": 500, "sqliteVacuumMb": 1024,
        "pruneAfterSync": True, "askBeforePrune": False,
        "keepDaysOnTablet": 1,
        "telegramEnabled": False, "telegramToken": "", "telegramChatId": "",
        "telegramProxy": "", "telegramLevels": ["warn", "alert"],
        "telegramPrefixDesktop": "[SK_DESK]", "telegramPrefixTablet": "[TAB]",
        "clockSkewSec": 60, "gapFactor": 2,
        "resourceWarnCpu": 60, "resourceAlertCpu": 80,
        "resourceWarnRssMb": 180, "resourceAlertRssMb": 240,
        "bufferWarnKb": 200, "bufferAlertKb": 400,
    }


def run_once(cfg: dict, yes: bool = True) -> dict:
    runner = SyncRunner(cfg, confirm_prune=(lambda *_: yes))
    try:
        return runner.run()
    finally:
        runner.close()


def alerts(cfg: dict) -> list[str]:
    db = Path(cfg["logsDir"]) / "alerts.db"
    if not db.exists():
        return []
    c = sqlite3.connect(db)
    rows = c.execute("SELECT code FROM alerts").fetchall()
    c.close()
    return [r[0] for r in rows]


def main() -> int:
    ok = True

    def check(name, cond, extra=""):
        nonlocal ok
        print(("PASS " if cond else "FAIL ") + name + (" — " + extra if extra else ""))
        ok = ok and bool(cond)

    # 1. normal: инкремент и запись
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        port = free_port()
        srv = serve(port, "normal")
        try:
            cfg = make_cfg(tmp, port)
            r1 = run_once(cfg)
            check("normal: ok", r1.get("ok"), r1.get("error", ""))
            check("normal: новые точки", r1["new_points"] > 0, str(r1["new_points"]))
            check("normal: архив +", r1["archive_added"] > 0, str(r1["archive_added"]))
            check("normal: горячая БД +", r1["hot_added"] > 0, str(r1["hot_added"]))
            check("normal: parquet", any((tmp / "data").glob("invest_*.parquet")))
            r2 = run_once(cfg)
            check("normal: повтор = 0 новых", r2["new_points"] == 0, str(r2["new_points"]))
            check("normal: отчёт CSV", (tmp / "logs" / "sync_log.csv").exists())
        finally:
            srv.shutdown()

    # 2. divergence: сначала нормальный прогон (архив), затем сервер с
    # подменённой точкой — расхождение должно попасть в алерты.
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        cfg = make_cfg(tmp, port := free_port())
        srv = serve(port, "normal")
        try:
            run_once(cfg)
        finally:
            srv.shutdown()
        port = free_port()
        srv = serve(port, "divergence")
        try:
            cfg["port"] = port
            cfg["fullSyncHours"] = 0     # разрешаем повторную сверку всех точек
            r = run_once(cfg)
            codes = alerts(cfg)
            check("divergence: алерт", "sync.divergence" in codes, str(codes[:6]))
            check("divergence: расхождения", r["diverged"] > 0, str(r["diverged"]))
        finally:
            srv.shutdown()

    # 3. bigbuffer: prune
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        port = free_port()
        srv = serve(port, "bigbuffer")
        try:
            cfg = make_cfg(tmp, port)
            r = run_once(cfg)
            check("prune: удалено", r["removed"] > 0, f"removed={r['removed']} left={r['left']}")
            codes = alerts(cfg)
            check("prune: алерт", "prune.done" in codes)
        finally:
            srv.shutdown()

    print("\n" + ("ВСЁ ОК" if ok else "ЕСТЬ ОШИБКИ"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
