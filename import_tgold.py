import sqlite3
import csv
import os
from datetime import datetime

# Paths
CSV_PATH = r"E:\_dev\jlab\jnlab\projects\54.hft\tinkoff_data.csv"
DB_PATH = r"E:\_dev\10.gpx\gpx_clock_beget\wclock3\parsers\invest\tracked_tickers.db"

# Ensure DB directory exists
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

# Connect to DB
conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()

# Create table if not exists
cur.execute('''
    CREATE TABLE IF NOT EXISTS last_prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME NOT NULL,
        figi TEXT NOT NULL,
        ticker TEXT,
        class_code TEXT,
        price REAL
    )
''')

# Check if data already exists
cur.execute("SELECT COUNT(*) FROM last_prices WHERE ticker = 'TGLD@'")
existing_count = cur.fetchone()[0]
print(f"Existing TGLD@ records: {existing_count}")

# Read CSV and import
imported = 0
skipped = 0

with open(CSV_PATH, 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    
    for row in reader:
        ticker = row.get('ticker', '')
        if ticker != 'TGLD@':
            skipped += 1
            continue
            
        # Parse timestamp
        time_str = row.get('time', '')
        try:
            # Handle format: 2026-03-03 07:00:00+00:00
            dt = datetime.fromisoformat(time_str.replace('+00:00', '+00:00'))
            timestamp = dt.strftime('%Y-%m-%d %H:%M:%S')
        except:
            skipped += 1
            continue
        
        # Use close price
        price = float(row.get('close', 0))
        
        # Insert
        cur.execute('''
            INSERT INTO last_prices (timestamp, figi, ticker, class_code, price)
            VALUES (?, ?, ?, ?, ?)
        ''', (timestamp, 'TCS80A101X50', 'TGLD@', 'TQTD', price))
        imported += 1

conn.commit()

# Show results
cur.execute("SELECT COUNT(*) FROM last_prices WHERE ticker = 'TGLD@'")
new_count = cur.fetchone()[0]
print(f"Imported: {imported}")
print(f"Total TGLD@ records: {new_count}")

# Show date range
cur.execute("SELECT MIN(timestamp), MAX(timestamp) FROM last_prices WHERE ticker = 'TGLD@'")
range_result = cur.fetchone()
print(f"Date range: {range_result[0]} to {range_result[1]}")

conn.close()
print("\nDone!")
