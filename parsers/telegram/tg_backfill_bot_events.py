#!/usr/bin/env python3
# tg_backfill_bot_events.py
# Дочитывает ИСТОРИЮ двух каналов «Сделки Бота» (Telethon, пользовательская
# сессия) -> bot_events в invest_portfolio.db. Повторяемый: upsert по (chat, msg_id).
# Запуск:  python3 tg_backfill_bot_events.py [--limit N] [--dry]
import argparse, asyncio, json, os, sqlite3, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DB = '/var/www/wclock5.startupassist.ru/parsers/invest/invest_portfolio.db'
sys.path.insert(0, HERE)
import importlib.util as _ilu
_tl = _ilu.spec_from_file_location('tg_login', os.path.join(HERE, 'tg_login.py'))
_l = _ilu.module_from_spec(_tl)
_tl.loader.exec_module(_l)

CHANNELS = (
    'Сделки Бота — ПРОД Сергей Финам (TGLD)',
    'Сделки Бота — ПРОД Сергей Т-Инвест (TGLD)',
)

def init_db():
    con = sqlite3.connect(DB)
    con.execute('''CREATE TABLE IF NOT EXISTS bot_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        msg_id INTEGER,
        chat TEXT,
        ts_epoch INTEGER NOT NULL,
        update_type TEXT,
        text TEXT,
        raw TEXT,
        UNIQUE(chat, msg_id))''')
    con.execute('CREATE INDEX IF NOT EXISTS idx_bot_events_ts ON bot_events(ts_epoch)')
    con.execute('CREATE INDEX IF NOT EXISTS idx_bot_events_chat ON bot_events(chat)')
    con.commit(); con.close()

def upsert(chat, msg_id, ts, text, dry):
    if dry or not text:
        return
    con = sqlite3.connect(DB)
    con.execute(
        'INSERT INTO bot_events (msg_id, chat, ts_epoch, update_type, text, raw)'
        ' VALUES (?,?,?,?,?,?)'
        ' ON CONFLICT(chat, msg_id) DO UPDATE SET'
        ' ts_epoch=excluded.ts_epoch, update_type=excluded.update_type,'
        ' text=excluded.text, raw=excluded.raw',
        (int(msg_id), chat, int(ts), 'channel_post', text[:4000], text[:4000]))
    con.commit(); con.close()

async def main():
    global DB
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=None)
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    if not a.dry:
        init_db()

    from telethon import TelegramClient
    client = TelegramClient(_l.SESSION, _l.API_ID, _l.API_HASH)
    await client.connect()
    if not await client.is_user_authorized():
        print('NOT AUTHORIZED'); return

    cats = {}   # -> классификация-каталог (частоты маркеров)
    stats = {}
    async for d in client.iter_dialogs():
        title = d.title or ''
        if title not in CHANNELS:
            continue
        stat = {'total': 0, 'txt': 0}
        print(f'=== channel: {title!r} id={d.id} ===', flush=True)
        async for m in client.iter_messages(d.id, limit=a.limit):
            t = m.message or ''
            stat['total'] += 1
            if not t:
                continue
            stat['txt'] += 1
            ts = int(m.date.timestamp()) if m.date else 0
            upsert(title, m.id, ts, t, a.dry)
            if a.dry and stat['txt'] <= 3:
                print(f'  [{m.id}] {t[:140]!r}')
            # каталог маркеров
            for key in ('BalanceChecker', 'T-test', 't_obs', '⚠', '🚨', '✅', '❌',
                        'Оборот', 'Убыток', 'прибыль', 'стоп', 'avg', 'commission'):
                if key in t:
                    cats.setdefault(key, 0)
                    cats[key] += 1
        stats[title] = stat
    await client.disconnect()

    print('\n=== STATS ===')
    for k, v in stats.items():
        print(f'{k}: total={v["total"]} with_text={v["txt"]}')
    print('\n=== MARKERS ===')
    for k in sorted(cats, key=lambda x: -cats[x]):
        print(f'{cats[k]:5d}  {k}')

if __name__ == '__main__':
    asyncio.run(main())