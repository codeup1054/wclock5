import sqlite3
import os

# Paths to source databases
SOURCE_INVEST = r"E:\_dev\10.gpx\gpx_clock_beget\invest_portfolio.db"
SOURCE_TICKERS = r"E:\_dev\10.gpx\gpx_clock_beget\tracked_tickers.db"

# Paths to target databases
TARGET_INVEST = r"E:\_dev\10.gpx\gpx_clock_beget\wclock3\parsers\invest\invest_portfolio.db"
TARGET_TICKERS = r"E:\_dev\10.gpx\gpx_clock_beget\wclock3\parsers\invest\tracked_tickers.db"

def copy_table_data(source_path, target_path, table_name):
    """Copy all data from source table to target table"""
    source_conn = sqlite3.connect(source_path)
    target_conn = sqlite3.connect(target_path)
    
    source_cur = source_conn.cursor()
    target_cur = target_conn.cursor()
    
    # Get table schema
    source_cur.execute(f"PRAGMA table_info({table_name})")
    columns = [col[1] for col in source_cur.fetchall()]
    print(f"  Columns: {columns}")
    
    # Get data
    source_cur.execute(f"SELECT * FROM {table_name}")
    rows = source_cur.fetchall()
    print(f"  Found {len(rows)} rows")
    
    if rows:
        # Insert data
        placeholders = ",".join(["?"] * len(columns))
        insert_sql = f"INSERT OR REPLACE INTO {table_name} ({','.join(columns)}) VALUES ({placeholders})"
        
        for row in rows:
            try:
                target_cur.execute(insert_sql, row)
            except Exception as e:
                print(f"  Error inserting row: {e}")
        
        target_conn.commit()
        print(f"  Copied {len(rows)} rows")
    
    source_conn.close()
    target_conn.close()

def copy_database(source_path, target_path, table_names):
    """Copy all tables from source to target database"""
    print(f"\n=== Copying {os.path.basename(source_path)} ===")
    print(f"  Source: {source_path}")
    print(f"  Target: {target_path}")
    
    # Ensure target directory exists
    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    
    for table in table_names:
        print(f"\n  Table: {table}")
        try:
            copy_table_data(source_path, target_path, table)
        except Exception as e:
            print(f"  Error: {e}")

# Copy invest_portfolio.db
copy_database(
    SOURCE_INVEST, 
    TARGET_INVEST, 
    ["portfolio_positions"]
)

# Copy tracked_tickers.db
copy_database(
    SOURCE_TICKERS, 
    TARGET_TICKERS, 
    ["last_prices", "settings"]
)

print("\n✅ Database copying completed!")
