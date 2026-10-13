#!/usr/bin/env python3
"""data_scan.py — поиск/анализ/устранение провалов данных в invest_buckets.

Артефакт-кейс (12/10/2026): 20 минут (finam/min) close ≈ 3.54M вместо ~8.4M.
Окно = >= --min-run подряд идущих точек, где close < factor * close до окна,
после чего значение возвращается к норме. Pровал чинится линейной интерполяцией
между соседями (close и сопутствующие поля OHLC/tgld_*), с временным бэкапом
затронутых строк в файл *_DELETE_AFTER_TEST (удалить после тестирования).

Использование:
  python3 sh/data_scan.py [--db P] [--factor 0.7] [--min-run 2] [--fix] [--list]
Кейс работает и с локальной копией БД, и по ssh на проде.

Пример на проде:
  scp sh/data_scan.py root@217.114.8.5:/tmp/ && \
  ssh root@217.114.8.5 "python3 /tmp/data_scan.py --db /var/www/wclock5.startupassist.ru/parsers/invest/invest_portfolio.db"
"""
import argparse, datetime, os, sqlite3, sys

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--db", default="parsers/invest/invest_portfolio.db", help="путь к sqlite БД")
parser.add_argument("--factor", type=float, default=0.7, help="порог провала: close[i] < factor*base (default 0.7)")
parser.add_argument("--min-run", type=int, default=2, help="мин. число подряд точек провала (default 2)")
parser.add_argument("--fix", action="store_true", help="устранить найденные провалы интерполяцией (с временным бэкапом)")
parser.add_argument("--list", action="store_true", help="показать только группы (source, res) и объёмы")
args = parser.parse_args()

def fmt(epoch, offset):
    d = datetime.datetime.utcfromtimestamp(epoch) + datetime.timedelta(hours=offset)
    return d.strftime("%Y-%m-%d %H:%M")

con = sqlite3.connect(args.db)
con.row_factory = sqlite3.Row
cur = con.cursor()

try:
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='invest_buckets'")
    if not cur.fetchone():
        sys.exit("invest_buckets отсутствует в %s" % args.db)
except sqlite3.DatabaseError as e:
    sys.exit("БД недоступна: %s" % e)

groups = {}
for r in cur.execute("SELECT DISTINCT COALESCE(source,'tinkoff') AS s, res FROM invest_buckets"):
    groups[(r["s"], r["res"])] = None

if args.list:
    for (s, res) in sorted(groups):
        n = cur.execute("SELECT COUNT(*) n FROM invest_buckets WHERE COALESCE(source,'tinkoff')=? AND res=?", (s, res)).fetchone()["n"]
        print(f"{s:8s} {res:5s} {n}")
    sys.exit(0)

rows_sql = "SELECT id, timestamp, ts_epoch, source, res, open, high, low, close, volume, tgld_value, tgld_total, tmon_value, lqdt_value FROM invest_buckets WHERE COALESCE(source,'tinkoff')=? AND res=? ORDER BY ts_epoch"

windows, trailing = [], []
prev = None  # последняя нормальная строка (левая граница окна)
for (s, res) in sorted(groups):
    rows = [dict(r) for r in cur.execute(rows_sql, (s, res)).fetchall()]
    rows = [r for r in rows if r["close"] is not None]
    if not rows:
        continue
    base = rows[0]["close"]
    win = []
    for r in rows:
        c = r["close"]
        if not win:
            if c < args.factor * base:
                win = [r]
            else:
                base = c
                prev = r
        else:
            if c < args.factor * base:
                win.append(r)
            else:
                if len(win) >= args.min_run:
                    windows.append((s, res, win, base, r, prev))
                win = []
                base = c
                prev = r
    if win and len(win) >= args.min_run:
        trailing.append((s, res, win, base, None, prev))

if not windows:
    print("Провалов (с восстановлением к базе) не найдено: factor=%s min_run=%s (%s)" % (args.factor, args.min_run, args.db))
    if trailing:
        print("Хвостовых окон без восстановления (смена уровня/пропуск данных — не провал):")
        for s, res, win, base, _, _ in trailing:
            ids = [r["id"] for r in win]
            print(f"  tail {s}/{res}  {len(win)} pts · id {ids[0]}..{ids[-1]}  close {base:,.0f} -> {win[-1]['close']:,.0f}")
    sys.exit(0)

print("Найдено окон провала: %d (factor=%s min_run=%s)\n" % (len(windows), args.factor, args.min_run))
for k, (s, res, win, base, nxt, _) in enumerate(windows, 1):
    ids = [r["id"] for r in win]
    close = [r["close"] for r in win]
    t0, t1 = win[0]["ts_epoch"], win[-1]["ts_epoch"]
    base_v = base
    end_v = nxt["close"] if nxt else close[-1]
    min_v = min(close)
    pct = min_v / base_v * 100 if base_v else 0
    nxt_txt = (fmt(nxt["ts_epoch"], 0) + " UTC") if nxt else "— (хвост до последней записи)"
    print(f"DIP-{k:02d}  {s}/{res}  {len(win)} pts · id {ids[0]}..{ids[-1]}")
    print(f"      время: {fmt(t0,0)}..{fmt(t1,0)} UTC  ({fmt(t0,3)}..{fmt(t1,3)} МСК)")
    print(f"      close: {base_v:,.0f} -> min {min_v:,.0f} ({pct:.0f}%) -> {end_v:,.0f}   после окна: {nxt_txt}")
    print()

if not args.fix:
    print("Режим диагностики (без --fix). Для устранения интерполяцией добавь --fix "
          "(бэкап строк уйдёт в *_DELETE_AFTER_TEST).")
    sys.exit(0)

# ---- устранение: линейная интерполяция окна между соседями ----
fields = ["open", "high", "low", "close", "tgld_value", "tgld_total", "tmon_value", "lqdt_value"]
stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
bak = f"{args.db}.bak_{stamp}_DELETE_AFTER_TEST"
bak_rows = []
updates = []

for (s, res, win, base_v, nxt, prev) in windows:
    if prev is None:
        sys.exit("Нет соседа слева для id %s — окно в начале данных, нужен ручной разбор" % win[0]["id"])
    if nxt is None:
        sys.exit("Окно идёт до конца данных — нужен ручной разбор (id %s)" % win[-1]["id"])
    left = {f: (prev[f] if prev[f] is not None else 0) for f in fields}
    right = {f: (nxt[f] if nxt[f] is not None else 0) for f in fields}

    n = len(win)
    for j, r in enumerate(win):
        t = (j + 1) / (n + 1)
        vals = [left[f] + (right[f] - left[f]) * t for f in fields]
        # нормализация OHLC в консистентную свечу
        o, h, l, c = vals[0], vals[1], vals[2], vals[3]
        vals[1] = max(h, o, c)
        vals[2] = min(l, o, c)
        bak_rows.append((r["id"], r))
        updates.append((vals, r["id"]))

with open(bak, "w") as f:
    f.write("-- TEMP BACKUP of rows from %s (%s); DELETE AFTER TESTING\n" % (args.db, stamp))
    for rid, r in bak_rows:
        f.write("INSERT INTO invest_buckets (id, timestamp, ts_epoch, source, res, open, high, low, close, volume, tgld_value, tgld_total, tmon_value, lqdt_value) VALUES (%d, '%s', %d, '%s', '%s', %s, %s, %s, %s, %s, %s, %s, %s, %s);\n" % (
            rid, r.get("timestamp") or "", r["ts_epoch"], r.get("source") or "", r.get("res") or "",
            *(str(x) if x is not None else "NULL" for x in (r["open"], r["high"], r["low"], r["close"], r["volume"], r["tgld_value"], r["tgld_total"], r["tmon_value"], r["lqdt_value"]))))
print("бэкап затронутых строк:", bak, os.path.getsize(bak), "байт")

sql = "UPDATE invest_buckets SET open=?, high=?, low=?, close=?, tgld_value=?, tgld_total=?, tmon_value=?, lqdt_value=? WHERE id=?"
for vals, rid in updates:
    cur.execute(sql, [round(v, 2) if v is not None else None for v in vals] + [rid])
con.commit()
print("updated+committed:", len(updates), "строк · бэкап пометить: после тестирования удалить %s" % bak)
print("Проверка: python3 sh/data_scan.py --db %s  (ожидается 'Провалов не найдено')" % args.db)
con.close()