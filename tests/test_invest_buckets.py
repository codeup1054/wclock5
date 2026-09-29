"""P3: единая бакет-таблица invest_buckets + read_history.

Проверяется на временных БД (db_path параметром, без env):
- apply_retention складывает сырые секунды → бакеты res='min', старые
  минуты → res='hour' (схлопывание), сырьё чистится;
- read_history читает бакеты (+ RAW-оверлей свежего окна) и отдаёт точки;
- миграция idempotенциона-переносит legacy portfolio_min/portfolio_hourly
  в бакеты;
- fallback: legacy-БД без invest_buckets по-прежнему отдаёт данные.
"""

import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import invest_repo as repo  # noqa: E402
from invest_repo import Snapshot, Position  # noqa: E402

NOW = int(time.time())


def _tmp_db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return path


def _mk_base(path):
    """Минимальные базовые таблицы, которые обычно создаёт invest_db.init_invest_db()."""
    con = repo.connect(path)
    con.executescript("""
        CREATE TABLE portfolio_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            total_value REAL NOT NULL, source TEXT DEFAULT 'tinkoff', ts_epoch INTEGER);
        CREATE TABLE portfolio_positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            instrument_type TEXT, name TEXT, ticker TEXT,
            quantity REAL, price REAL, value REAL,
            source TEXT DEFAULT 'tinkoff', ts_epoch INTEGER);
    """)
    con.commit()
    con.close()


class BucketWriterTest(unittest.TestCase):

    def setUp(self):
        self.db = _tmp_db()
        _mk_base(self.db)
        repo.run_migrations(self.db)

    def tearDown(self):
        try:
            os.unlink(self.db)
        except OSError:
            pass

    def _seed_positions(self, base, count=120, step=60, source="finam"):
        for i in range(count):
            snap = Snapshot(source=source, ts_epoch=base + i * step,
                            positions=[Position(value=1000.0 + i, source=source)])
            repo.write_snapshot(snap, db_path=self.db)

    def test_fold_raw_to_min_buckets(self):
        base = NOW - 3600 * 26 - 120  # старше fold-окна (90с)
        self._seed_positions(base, count=120)
        repo.apply_retention(db_path=self.db)

        con = repo.connect(self.db)
        mins = con.execute(
            "SELECT COUNT(*) FROM invest_buckets WHERE res='min'").fetchone()[0]
        hours = con.execute(
            "SELECT COUNT(*) FROM invest_buckets WHERE res='hour'").fetchone()[0]
        raw_left = con.execute(
            "SELECT COUNT(*) FROM portfolio_positions").fetchone()[0]
        con.close()
        self.assertEqual(hours, 0, "2 часа данных не должны превращаться в часы")
        self.assertGreaterEqual(mins, 90, "минутных бакетов нет")
        self.assertEqual(raw_left, 0, "сырые секунды старше окна не вычищены")

    def test_read_history_over_buckets(self):
        base = NOW - 3600 * 26 - 120
        self._seed_positions(base, count=120)
        repo.apply_retention(db_path=self.db)

        res = repo.read_history("-27 hour", 3600, db_path=self.db)
        self.assertNotIn("_error", res)
        keys = [k for k in res if not k.startswith("_")]
        self.assertGreaterEqual(len(keys), 2, "нет полноценных часовых точек")
        for k in keys:
            self.assertTrue(isinstance(res[k], list), f"точка не массив: {k}")

    def test_raw_overlay_fresh_window(self):
        # Свежая секунда (в пределах окна folding) попадает в ответ через
        # RAW-оверлей, минуя бакеты.
        base = NOW - 3600 * 26 - 20
        fresh = NOW - 30
        self._seed_positions(base, count=60)
        repo.write_snapshot(
            Snapshot(source="finam", ts_epoch=fresh,
                     positions=[Position(value=7777.0, source="finam")]),
            db_path=self.db)
        repo.apply_retention(db_path=self.db)

        res = repo.read_history("-2 hour", 3600, db_path=self.db)
        self.assertNotIn("_error", res)
        last_key = max(k for k in res if not k.startswith("_"))
        items = res[last_key]
        self.assertEqual(items[0]["value"], 7777.0,
                         "свежая секунда не пришла через RAW-оверлей")


class BucketMigrationTest(unittest.TestCase):

    def _mk(self):
        db = _tmp_db()
        con = repo.connect(db)
        con.executescript("""
            CREATE TABLE portfolio_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                total_value REAL NOT NULL, source TEXT DEFAULT 'tinkoff', ts_epoch INTEGER);
            CREATE TABLE portfolio_positions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                instrument_type TEXT, name TEXT, ticker TEXT,
                quantity REAL, price REAL, value REAL,
                source TEXT DEFAULT 'tinkoff', ts_epoch INTEGER);
            CREATE TABLE portfolio_min (
                id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
                ts_epoch INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'tinkoff',
                open REAL, high REAL, low REAL, close REAL, volume INTEGER DEFAULT 0,
                tgld_value REAL, tgld_total REAL, tmon_value REAL, lqdt_value REAL,
                UNIQUE(ts_epoch, source));
            CREATE TABLE portfolio_hourly (
                id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
                ts_epoch INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'tinkoff',
                open REAL, high REAL, low REAL, close REAL, volume INTEGER DEFAULT 0,
                tgld_value REAL, tgld_total REAL, tmon_value REAL, lqdt_value REAL,
                UNIQUE(ts_epoch, source));
        """)
        now = NOW - 30 * 86400
        con.executemany(
            "INSERT INTO portfolio_min (timestamp, ts_epoch, source, open, high, low, close, volume)"
            " VALUES (?,?,?,?,?,?,?,?)",
            [(repo.to_iso(repo.datetime.fromtimestamp(e, tz=repo.timezone.utc)), e, "finam",
              100.0 + i, 110.0 + i, 90.0 + i, 105.0 + i, 1)
             for i, e in enumerate(range(now, now + 120 * 60, 60))])
        con.executemany(
            "INSERT INTO portfolio_hourly (timestamp, ts_epoch, source, open, high, low, close, volume)"
            " VALUES (?,?,?,?,?,?,?,?)",
            [(repo.to_iso(repo.datetime.fromtimestamp(e, tz=repo.timezone.utc)), e, "finam",
              1000.0 + i, 1100.0 + i, 900.0 + i, 1050.0 + i, 1)
             for i, e in enumerate(range(now - 60 * 86400, now - 40 * 86400, 3600))])
        con.commit()
        con.close()
        return db

    def test_migration_copies_legacy_idempotent(self):
        db = self._mk()
        repo.run_migrations(db)
        repo.run_migrations(db)  # повторный прогон не должен плодить дубли
        con = repo.connect(db)
        mins = con.execute(
            "SELECT COUNT(*) FROM invest_buckets WHERE res='min'").fetchone()[0]
        hours = con.execute(
            "SELECT COUNT(*) FROM invest_buckets WHERE res='hour'").fetchone()[0]
        con.close()
        self.assertEqual(mins, 120)
        self.assertEqual(hours, 480)
        self.assertGreater(len(repo.read_history("-50 day", 86400, db_path=db)), 0)

    def test_reader_fallback_legacy_no_buckets(self):
        db = self._mk()
        # без миграции: бакеты не существуют → читаем legacy-таблицы
        con = repo.connect(db)
        con.close()
        res = repo.read_history("-50 day", 86400, db_path=db)
        self.assertNotIn("_error", res)
        self.assertGreater(len([k for k in res if not k.startswith("_")]), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)