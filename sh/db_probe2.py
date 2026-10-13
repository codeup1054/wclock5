#!/usr/bin/env python3
import sqlite3
db = "parsers/invest/invest_portfolio.db"
con = sqlite3.connect(db)
con.row_factory = sqlite3.Row
cur = con.cursor()

print("==== bot_events: последние финан-сообщения ====")
for r in cur.execute("""
    SELECT id, msg_id, chat, ts_epoch, substr(text,1,500) t, datetime(ts_epoch,'unixepoch','+3 hours') msk
    FROM bot_events
    WHERE chat LIKE '%Финам%'
    ORDER BY ts_epoch DESC LIMIT 12
"""):
    print("----", dict(r))

print()
print("==== bot_events: последние финан-сообщения (HМЕННО с Оборот) ====")
for r in cur.execute("""
    SELECT id, msg_id, chat, ts_epoch, substr(text,1,600) t, datetime(ts_epoch,'unixepoch','+3 hours') msk
    FROM bot_events
    WHERE chat LIKE '%Финам%' AND text LIKE '%Оборот%'
    ORDER BY ts_epoch DESC LIMIT 6
"""):
    print("----", dict(r))

print()
print("==== strategy_summary raw для 16/17/18.09 ====")
for r in cur.execute("""
    SELECT day, source, turnover, commission, window, substr(raw,1,700) raw, datetime(ts_epoch,'unixepoch','+3 hours') msk
    FROM strategy_summary
    WHERE day IN ('2026-09-16','2026-09-17','2026-09-18')
    ORDER BY day DESC, source
"""):
    print(dict(r))

con.close()