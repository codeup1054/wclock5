# invest_db.py

import os
import sqlite3
from datetime import datetime, timezone, timedelta

# Новый путь: рядом с демоном
DB_PATH = os.path.join(os.path.dirname(__file__), "parsers", "invest", "invest_portfolio.db")

DEFAULT_SETTINGS = {
    'INVEST_UPDATE_INTERVAL': 300,
}

RETENTION_RAW_DAYS = 3  # сырые снапшоты храним 3 дня, потом схлопываем в часовые свечи

def init_invest_db():
    # Создаём папку, если её нет
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA busy_timeout = 5000")
    cursor = conn.cursor()

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS portfolio_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            total_value REAL NOT NULL
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS portfolio_positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            instrument_type TEXT,
            name TEXT,
            ticker TEXT,
            quantity REAL,
            price REAL,
            value REAL
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS portfolio_hourly (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL UNIQUE,
            open REAL,
            high REAL,
            low REAL,
            close REAL,
            volume INTEGER DEFAULT 0
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    ''')

    for key, value in DEFAULT_SETTINGS.items():
        cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))

    # Индексы
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_portfolio_positions_timestamp ON portfolio_positions(timestamp)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_portfolio_history_timestamp ON portfolio_history(timestamp)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_portfolio_hourly_timestamp ON portfolio_hourly(timestamp)")

    conn.commit()
    conn.close()
    return DB_PATH


def aggregate_old_data(db_path=None):
    """Схлопывает сырые снапшоты старше RETENTION_RAW_DAYS в часовые OHLC-свечки."""
    if db_path is None:
        db_path = DB_PATH
    if not os.path.exists(db_path):
        return

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA busy_timeout = 5000")
    cur = conn.cursor()

    # Гарантируем существование таблицы
    cur.execute('''
        CREATE TABLE IF NOT EXISTS portfolio_hourly (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL UNIQUE,
            open REAL,
            high REAL,
            low REAL,
            close REAL,
            volume INTEGER DEFAULT 0
        )
    ''')
    cur.execute("CREATE INDEX IF NOT EXISTS idx_portfolio_hourly_timestamp ON portfolio_hourly(timestamp)")

    cutoff = (datetime.now(timezone.utc) - timedelta(days=RETENTION_RAW_DAYS)).isoformat()

    # Группируем сырые снапшоты по часам и считаем OHLC
    cur.execute("""
        SELECT 
            strftime('%Y-%m-%dT%H:00:00', sq.timestamp) AS hour,
            MIN(sq.timestamp) AS first_ts,
            MAX(sq.timestamp) AS last_ts,
            MIN(sq.total) AS low,
            MAX(sq.total) AS high,
            COUNT(*) AS volume
        FROM (
            SELECT timestamp, SUM(value) AS total
            FROM portfolio_positions
            WHERE timestamp < ?
            GROUP BY timestamp
        ) sq
        GROUP BY hour
        ORDER BY hour ASC
    """, (cutoff,))

    hours = cur.fetchall()
    if not hours:
        conn.close()
        return

    # Для каждого часа достаём open (first snapshot) и close (last snapshot)
    for hour, first_ts, last_ts, low, high, volume in hours:
        cur.execute("SELECT SUM(value) FROM portfolio_positions WHERE timestamp = ?", (first_ts,))
        open_val = cur.fetchone()[0]
        cur.execute("SELECT SUM(value) FROM portfolio_positions WHERE timestamp = ?", (last_ts,))
        close_val = cur.fetchone()[0]

        cur.execute("""
            INSERT INTO portfolio_hourly (timestamp, open, high, low, close, volume)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(timestamp) DO UPDATE SET
                high = MAX(high, excluded.high),
                low = MIN(low, excluded.low),
                close = excluded.close,
                volume = volume + excluded.volume
        """, (hour, open_val, high, low, close_val, volume))

    # Удаляем схлопнутые сырые данные
    cur.execute("DELETE FROM portfolio_positions WHERE timestamp < ?", (cutoff,))
    cur.execute("DELETE FROM portfolio_history WHERE timestamp < ?", (cutoff,))

    conn.commit()
    conn.close()

    total_snapshots = sum(h[5] for h in hours)  # volume sum
    print(f"📊 Агрегация: {len(hours)} часовых свечей из {total_snapshots} снапшотов", flush=True)


if __name__ == "__main__":
    init_invest_db()
    print(f"✅ База данных инвестиций инициализирована: {DB_PATH}")