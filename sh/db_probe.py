#!/usr/bin/env python3
import sqlite3, json
db = "parsers/invest/invest_portfolio.db"
con = sqlite3.connect(db)
con.row_factory = sqlite3.Row
cur = con.cursor()

print("tables:", [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")])
print("strategy_summary cols:", [c[1] for c in cur.execute("PRAGMA table_info(strategy_summary)")])

# последние записи по каждому источнику
print("---- strategy_summary: последние 12 ----")
for r in cur.execute("SELECT day, source, capital, turnover FROM strategy_summary ORDER BY day DESC, id DESC LIMIT 12"):
    print(dict(r))

print("---- strategy_summary по источнику, сводка по дням (последние вхожд. на день) ----")
q = cur.execute("""
  SELECT s.day, s.source, s.capital, s.turnover
  FROM strategy_summary s
  JOIN (SELECT source, day, MAX(id) mid FROM strategy_summary GROUP BY source, day) m
    ON m.source = s.source AND m.mid = s.id
  ORDER BY s.day DESC, s.source LIMIT 30
""")
for r in q:
    print(dict(r))

for t in ("trades", "portfolio_positions", "portfolio_min", "portfolio_hourly"):
    try:
        cols = [c[1] for c in cur.execute(f"PRAGMA table_info({t})")]
        print(f"---- {t} cols:", cols)
        n = cur.execute(f"SELECT COUNT(*) n FROM {t}").fetchone()["n"]
        print("rows:", n)
        if n:
            rows = cur.execute(f"SELECT * FROM {t} ORDER BY rowid DESC LIMIT 5").fetchall()
            for r in rows:
                print(" ", dict(r))
    except Exception as e:
        print(f"---- {t} ERR", e)

con.close()