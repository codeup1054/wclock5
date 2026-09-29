#!/usr/bin/env python3
# Читает посты каналов «Сделки Бота» НАПРЯМУЮ через Telethon (пользовательская
# сессия wclock_session; зеркало lab_inspector НЕ используется),
# парсит обороты стратегии -> invest_portfolio.db :: strategy_summary,
# сохраняет сообщения из каналов -> bot_events.
import asyncio, os, re, sys, time
from telethon import TelegramClient

HERE = os.path.dirname(os.path.abspath(__file__))
DB = HERE + '/../invest/invest_portfolio.db'

sys.path.insert(0, HERE)
import importlib.util as _ilu
_tl = _ilu.spec_from_file_location('tg_login', os.path.join(HERE, 'tg_login.py'))
_l = _ilu.module_from_spec(_tl)
_tl.loader.exec_module(_l)

CHANNELS = (
    'Сделки Бота — ПРОД Сергей Финам (TGLD)',
    'Сделки Бота — ПРОД Сергей Т-Инвест (TGLD)',
)

def _conn():
    import sqlite3
    return sqlite3.connect(DB, timeout=30)

def init_db():
    import sqlite3
    con = _conn()
    con.execute('''CREATE TABLE IF NOT EXISTS strategy_summary(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_epoch INTEGER NOT NULL,
        day TEXT,
        source TEXT,
        capital REAL,
        turnover REAL,
        raw TEXT)
    ''')
    cols = [r[1] for r in con.execute('PRAGMA table_info(strategy_summary)')]
    if 'commission' not in cols:
        con.execute('ALTER TABLE strategy_summary ADD COLUMN commission REAL')
    if 'window' not in cols:
        con.execute('ALTER TABLE strategy_summary ADD COLUMN window TEXT')
    if 'msg_id' not in cols:
        con.execute('ALTER TABLE strategy_summary ADD COLUMN msg_id INTEGER')
    con.execute('CREATE INDEX IF NOT EXISTS idx_strategy_summary_day ON strategy_summary(day, source)')
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

NUM = r"[\d'\u00a0 ]+?(?:\.\d+)?"
def num(s):
    return float(re.sub(r"[^\d.]", '', s))

def parse(text):
    tov = re.search(r'Оборот\s*(' + NUM + r')₽', text)
    if not tov:
        return None
    cap = re.search(r'💼\s*(' + NUM + r')₽', text)
    day = re.search(r'📅\s*(\d{4}-\d{2}-\d{2})', text)
    if 'у Финама' in text:
        src = 'tinkoff'
    elif 'Финам' in text:
        src = 'finam'
    else:
        src = 'unknown'
    est = re.search(r'было бы:\s*(' + NUM + r')₽', text)
    win = re.search(r'📅\s*\d{4}-\d{2}-\d{2}\s*с\s*(\d{2}:\d{2})\s*до\s*(\d{2}:\d{2})', text)
    return {
        'turnover': num(tov.group(1)),
        'capital': num(cap.group(1)) if cap else None,
        'day': day.group(1) if day else None,
        'source': src,
        'commission': num(est.group(1)) if est else None,
        'window': f"{win.group(1)}–{win.group(2)}" if win else None,
    }

def save(msg_id, msg_ts, p, text):
    import sqlite3
    con = _conn()
    if p['day'] and p['source'] and p['source'] != 'unknown':
        existing = con.execute(
            'SELECT id, ts_epoch, raw, msg_id FROM strategy_summary WHERE day=? AND source=?',
            (p['day'], p['source'])).fetchone()
        if existing:
            eid, old_ts, old_raw, old_msg_id = existing
            if msg_id == old_msg_id:
                # То же сообщение: бот в течение дня редактирует текст поста
                # (оборот 0 → текущий). Ts при правке не меняется, поэтому
                # ориентируемся на изменение текста.
                if old_raw == text:
                    con.close(); return
                con.execute(
                    'UPDATE strategy_summary SET ts_epoch=?, capital=?, turnover=?, commission=?, window=?, raw=? WHERE id=?',
                    (int(msg_ts), p['capital'], p['turnover'], p.get('commission'), p.get('window'), text[:800], eid))
                con.commit(); con.close()
                return
            if old_msg_id is None and int(msg_ts) == (old_ts or 0) and old_raw != text:
                # Legacy-строка (msg_id не был записан): тот же ts и изменившийся
                # текст = правка того же поста. Обновляем и фиксируем msg_id.
                con.execute(
                    'UPDATE strategy_summary SET msg_id=?, ts_epoch=?, capital=?, turnover=?, commission=?, window=?, raw=? WHERE id=?',
                    (int(msg_id), int(msg_ts), p['capital'], p['turnover'], p.get('commission'), p.get('window'), text[:800], eid))
                con.commit(); con.close()
                return
            if old_ts and int(msg_ts) <= (old_ts or 0):
                con.close(); return
            con.execute(
                'UPDATE strategy_summary SET msg_id=?, ts_epoch=?, capital=?, turnover=?, commission=?, window=?, raw=? WHERE id=?',
                (int(msg_id), int(msg_ts), p['capital'], p['turnover'], p.get('commission'), p.get('window'), text[:800], eid))
            con.commit(); con.close()
            return
    con.execute(
        'INSERT INTO strategy_summary (ts_epoch, day, source, capital, turnover, commission, window, raw, msg_id)'
        ' VALUES (?,?,?,?,?,?,?,?,?)',
        (int(msg_ts), p['day'], p['source'], p['capital'], p['turnover'], p.get('commission'), p.get('window'), text[:800], int(msg_id)))
    con.commit(); con.close()

def save_event(chat, upd_type, msg_id, ts, text):
    import sqlite3
    con = _conn()
    con.execute(
        'INSERT INTO bot_events (msg_id, chat, ts_epoch, update_type, text, raw)'
        ' VALUES (?,?,?,?,?,?)'
        ' ON CONFLICT(chat, msg_id) DO UPDATE SET'
        ' ts_epoch=excluded.ts_epoch, update_type=excluded.update_type,'
        ' text=excluded.text, raw=excluded.raw',
        (int(msg_id), chat, int(ts), upd_type, text[:4000], text[:4000]))
    con.commit(); con.close()

async def scan_channel(client, ent):
    """Читает свежие посты канала напрямую (без зеркала)."""
    title = ent.title or ''
    n = 0
    async for m in client.iter_messages(ent, limit=50):
        text = m.message or ''
        ts = int(m.date.timestamp()) if m.date else int(time.time())
        if m.id is not None:
            save_event(title, 'channel_post', m.id, ts, text)
        p = parse(text) if text else None
        if p:
            save(m.id, ts, p, text)
            print(f"💾 {title}: оборот {p['turnover']:,.2f} капитал {p['capital']} ком {p.get('commission')} day={p['day']}", flush=True)
            n += 1
    if n:
        print(f'  -> новых/обновлённых записей: {n}', flush=True)

async def main():
    print('🔄 tg_turnover_daemon start (прямое чтение каналов, без зеркала)', flush=True)
    init_db()
    client = TelegramClient(_l.SESSION, _l.API_ID, _l.API_HASH)
    await client.connect()
    if not await client.is_user_authorized():
        print('NOT AUTHORIZED — демон завершён', flush=True)
        await client.disconnect()
        return
    me = await client.get_me()
    print(f'  сессия: {getattr(me, "username", None) or me.first_name} id={me.id}', flush=True)

    entities = {}
    for title in CHANNELS:
        async for d in client.iter_dialogs():
            if d.title == title:
                entities[title] = d
                break
        if title not in entities:
            print(f'⚠️ канал не найден: {title!r}', flush=True)
        else:
            print(f'  канал ок: {title!r} id={entities[title].id}', flush=True)

    if not entities:
        print('Нет доступных каналов — демон завершён', flush=True)
        await client.disconnect()
        return

    while True:
        try:
            for title, ent in entities.items():
                await scan_channel(client, ent)
        except Exception as e:
            print('⚠️', e, flush=True)
        await asyncio.sleep(45)

if __name__ == '__main__':
    asyncio.run(main())