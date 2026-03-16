# invest_db.py

import os
import sqlite3

# Новый путь: рядом с демоном
DB_PATH = os.path.join(os.path.dirname(__file__), "parsers", "invest", "invest_portfolio.db")

DEFAULT_SETTINGS = {
    'INVEST_UPDATE_INTERVAL': 300,
}

def init_invest_db():
    # Создаём папку, если её нет
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
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
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    ''')

    for key, value in DEFAULT_SETTINGS.items():
        cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))

    conn.commit()
    conn.close()
    return DB_PATH

if __name__ == "__main__":
    init_invest_db()
    print(f"✅ База данных инвестиций инициализирована: {DB_PATH}")