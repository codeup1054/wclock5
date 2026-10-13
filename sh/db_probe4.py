#!/usr/bin/env python3
import sqlite3
con = sqlite3.connect("parsers/invest/invest_portfolio.db")
con.row_factory = sqlite3.Row
print("---- finam summary 16-18.09 ----")
for r in con.execute("""
    SELECT day, source, turnover, capital, window, msg_id,
           datetime(ts_epoch,'unixepoch','+3 hours') msk
    FROM strategy_summary
    WHERE source='finam' AND day IN ('2026-09-16','2026-09-17','2026-09-18')
    ORDER BY day
"""):
    print(dict(r))
con.close()