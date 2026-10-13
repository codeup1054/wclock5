#!/usr/bin/env python3
import sqlite3
db = "parsers/invest/invest_portfolio.db"
con = sqlite3.connect(db)
con.row_factory = sqlite3.Row
cur = con.cursor()

print("==== strategy_summary с day IS NULL (последние 10) ====")
for r in cur.execute("""
    SELECT id, day, source, turnover, capital, window, substr(raw,1,160) raw,
           datetime(ts_epoch,'unixepoch','+3 hours') msk, ts_epoch
    FROM strategy_summary
    WHERE day IS NULL
    ORDER BY id DESC LIMIT 10
"""):
    print(dict(r))

print()
print("==== все finance события за 17-18.09 (полностью, до 900 симв) ====")
for r in cur.execute("""
    SELECT msg_id, ts_epoch, datetime(ts_epoch,'unixepoch','+3 hours') msk, substr(text,1,900) t
    FROM bot_events
    WHERE chat LIKE '%Финам%' AND ts_epoch >= 1789620000
    ORDER BY ts_epoch ASC
"""):
    print("----", dict(r))

con.close()