# invest_db.py — тонкая обёртка совместимости над invest_repo (mediation-слой).
# Весь новый код должен использовать invest_repo напрямую.

import os
import sqlite3

from invest_repo import (
    DB_PATH,
    RETENTION_RAW_DAYS,
    apply_retention,
    connect,
    run_migrations,
)

__all__ = ["DB_PATH", "RETENTION_RAW_DAYS", "init_invest_db", "aggregate_old_data"]


def init_invest_db():
    """Создаёт таблицы (если нет) и применяет миграции. Совместимость со старым API."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = connect(DB_PATH)
    cur = conn.cursor()

    cur.execute('''
        CREATE TABLE IF NOT EXISTS portfolio_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            total_value REAL NOT NULL,
            source TEXT DEFAULT 'tinkoff',
            ts_epoch INTEGER
        )
    ''')

    cur.execute('''
        CREATE TABLE IF NOT EXISTS portfolio_positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            instrument_type TEXT,
            name TEXT,
            ticker TEXT,
            quantity REAL,
            price REAL,
            value REAL,
            source TEXT DEFAULT 'tinkoff',
            ts_epoch INTEGER
        )
    ''')

    cur.execute('''
        CREATE TABLE IF NOT EXISTS portfolio_hourly (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            ts_epoch INTEGER NOT NULL,
            source TEXT NOT NULL DEFAULT 'tinkoff',
            open REAL, high REAL, low REAL, close REAL,
            volume INTEGER DEFAULT 0,
            UNIQUE(ts_epoch, source)
        )
    ''')

    cur.execute('''
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    ''')

    for key, value in {"INVEST_UPDATE_INTERVAL": 300}.items():
        cur.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))

    conn.commit()
    conn.close()

    run_migrations()
    return DB_PATH


def aggregate_old_data(db_path=None):
    """Совместимость: схлопывание сырых снапшотов в часовые свечи."""
    apply_retention(db_path)


if __name__ == "__main__":
    init_invest_db()
    print(f"✅ База данных инвестиций инициализирована: {DB_PATH}")
