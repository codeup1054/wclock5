"""Архив истории портфелей: parquet по месяцам, fallback SQLite.

Формат точки: {"source": str, "ts": ms, "value": float}.
Ключ дедупликации — (source, ts). Значения сравниваются для алерта о расхождении.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

TOL_ABS = 1.0          # ₽
TOL_REL = 1e-4         # 0.01 %


def _differs(a: float, b: float) -> bool:
    return abs(a - b) > max(TOL_ABS, abs(a) * TOL_REL)


def _point_key(p: dict) -> tuple:
    return (p["source"], int(p["ts"]))


def open_archive(cfg: dict):
    """Parquet, если есть pandas+pyarrow; иначе SQLite."""
    root = Path(cfg["archiveDir"])
    root.mkdir(parents=True, exist_ok=True)
    try:
        import pandas  # noqa: F401
        import pyarrow  # noqa: F401
        return ParquetArchive(root, cfg)
    except Exception:
        return SqliteArchive(root, cfg)


class ParquetArchive:
    kind = "parquet"

    def __init__(self, root: Path, cfg: dict):
        self.root = root
        self.max_mb = int(cfg.get("maxArchiveMb", 500))
        self.state_path = root / "state.json"
        self._state = self._load_state()

    # ---------------------------------------------------------- state
    def _load_state(self) -> dict:
        if self.state_path.exists():
            try:
                return json.loads(self.state_path.read_text(encoding="utf-8"))
            except Exception:
                pass
        return self._scan_state()

    def _scan_state(self) -> dict:
        state = {"count": 0, "last": {}, "ranges": {}}
        try:
            import pandas as pd
            for f in sorted(self.root.glob("invest_*.parquet")):
                try:
                    df = pd.read_parquet(f, columns=["source", "ts"])
                except Exception:
                    continue
                state["count"] += len(df)
                for src, grp in df.groupby("source"):
                    lo, hi = int(grp["ts"].min()), int(grp["ts"].max())
                    r = state["ranges"].setdefault(str(src), [lo, hi])
                    r[0] = min(r[0], lo)
                    r[1] = max(r[1], hi)
                    state["last"][str(src)] = max(state["last"].get(str(src), 0), hi)
        except Exception:
            pass
        self._save_state(state)
        return state

    def _save_state(self, state: dict | None = None) -> None:
        if state is not None:
            self._state = state
        try:
            self.state_path.write_text(
                json.dumps(self._state, ensure_ascii=False, indent=1), encoding="utf-8")
        except Exception:
            pass

    # ---------------------------------------------------------- files
    def _month_path(self, ts_ms: int) -> Path:
        dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
        base = self.root / f"invest_{dt:%Y%m}.parquet"
        if not base.exists() or base.stat().st_size <= self.max_mb * 1024 * 1024:
            return base
        # ротация: тот же месяц, следующий свободный part
        n = 2
        while True:
            p = self.root / f"invest_{dt:%Y%m}_p{n}.parquet"
            if not p.exists() or p.stat().st_size <= self.max_mb * 1024 * 1024:
                return p
            n += 1

    # ---------------------------------------------------------- api
    def add(self, points: list[dict]) -> dict:
        if not points:
            return {"added": 0, "diverged": [], "total": self.count()}

        import pandas as pd
        by_month: dict[Path, list[dict]] = {}
        for p in points:
            by_month.setdefault(self._month_path(int(p["ts"])), []).append(p)

        added = 0
        diverged = []
        for path, pts in by_month.items():
            cols = ["source", "ts", "value", "origin", "synced_ts"]
            if path.exists():
                try:
                    old = pd.read_parquet(path)
                except Exception:
                    old = pd.DataFrame(columns=cols)
            else:
                old = pd.DataFrame(columns=cols)
            new = pd.DataFrame(pts)
            new["origin"] = "tablet"
            new["synced_ts"] = int(time.time())

            if len(old):
                old_idx = old.set_index(["source", "ts"])["value"].to_dict()
                for p in pts:
                    k = (p["source"], int(p["ts"]))
                    if k in old_idx and _differs(float(p["value"]), float(old_idx[k])):
                        diverged.append({"source": p["source"], "ts": int(p["ts"]),
                                         "archive": float(old_idx[k]),
                                         "tablet": float(p["value"])})
                combined = pd.concat([old, new], ignore_index=True)
            else:
                combined = new
            combined = combined.drop_duplicates(subset=["source", "ts"], keep="last")
            # точный прирост: число ключей, которых не было в old
            if len(old):
                old_keys = set(zip(old["source"], old["ts"]))
                added += sum(1 for p in pts if (p["source"], int(p["ts"])) not in old_keys)
            else:
                added += len(combined)

            tmp = path.with_suffix(".parquet.tmp")
            combined.to_parquet(tmp, index=False, compression="zstd")
            os.replace(tmp, path)

        st = self._state
        st["count"] = int(st.get("count", 0)) + added
        for p in points:
            src = p["source"]
            ts = int(p["ts"])
            st["last"][src] = max(st["last"].get(src, 0), ts)
            r = st["ranges"].setdefault(src, [ts, ts])
            r[0] = min(r[0], ts)
            r[1] = max(r[1], ts)
        self._save_state()
        return {"added": added, "diverged": diverged, "total": st["count"]}

    def max_ts(self) -> int:
        return max(self._state.get("last", {}).values(), default=0)

    def last_by_source(self) -> dict:
        return dict(self._state.get("last", {}))

    def count(self) -> int:
        return int(self._state.get("count", 0))

    def ranges(self) -> dict:
        return dict(self._state.get("ranges", {}))

    def size_bytes(self) -> int:
        return sum(f.stat().st_size for f in self.root.glob("*") if f.is_file())

    def vacuum_if_needed(self) -> bool:
        return False


class SqliteArchive:
    kind = "sqlite"

    def __init__(self, root: Path, cfg: dict):
        self.root = root
        self.db_path = root / "invest.db"
        self.vacuum_mb = int(cfg.get("sqliteVacuumMb", 1024))
        self.conn = sqlite3.connect(self.db_path)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS history (
                source TEXT NOT NULL,
                ts INTEGER NOT NULL,
                value REAL NOT NULL,
                origin TEXT DEFAULT 'tablet',
                synced_ts INTEGER,
                PRIMARY KEY (source, ts)
            )
        """)
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_history_ts ON history(ts)")
        self.conn.commit()

    def add(self, points: list[dict]) -> dict:
        added = 0
        diverged = []
        now = int(time.time())
        cur = self.conn.cursor()
        for p in points:
            src = p["source"]
            ts = int(p["ts"])
            val = float(p["value"])
            row = cur.execute("SELECT value FROM history WHERE source=? AND ts=?",
                              (src, ts)).fetchone()
            if row is not None:
                if _differs(val, float(row[0])):
                    diverged.append({"source": src, "ts": ts,
                                     "archive": float(row[0]), "tablet": val})
                cur.execute("UPDATE history SET value=?, synced_ts=? WHERE source=? AND ts=?",
                            (val, now, src, ts))
            else:
                cur.execute("INSERT INTO history(source, ts, value, origin, synced_ts) "
                            "VALUES (?,?,?,?,?)", (src, ts, val, "tablet", now))
                added += 1
        self.conn.commit()
        return {"added": added, "diverged": diverged, "total": self.count()}

    def max_ts(self) -> int:
        row = self.conn.execute("SELECT MAX(ts) FROM history").fetchone()
        return int(row[0] or 0)

    def last_by_source(self) -> dict:
        return {r[0]: int(r[1]) for r in
                self.conn.execute("SELECT source, MAX(ts) FROM history GROUP BY source")}

    def count(self) -> int:
        return int(self.conn.execute("SELECT COUNT(*) FROM history").fetchone()[0])

    def ranges(self) -> dict:
        return {r[0]: [int(r[1]), int(r[2])] for r in
                self.conn.execute("SELECT source, MIN(ts), MAX(ts) FROM history GROUP BY source")}

    def size_bytes(self) -> int:
        return self.db_path.stat().st_size if self.db_path.exists() else 0

    def vacuum_if_needed(self) -> bool:
        limit = self.vacuum_mb * 1024 * 1024
        if self.size_bytes() > limit:
            self.conn.execute("VACUUM")
            self.conn.commit()
            return True
        return False
