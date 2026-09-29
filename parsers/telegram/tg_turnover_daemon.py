#!/usr/bin/env python3
# Читает посты каналов «Сделки Бота» НАПРЯМУЮ через Telethon (пользовательская
# сессия wclock_session; зеркало lab_inspector НЕ используется),
# парсит обороты стратегии -> invest_portfolio.db :: strategy_summary,
# сохраняет сообщения из каналов -> bot_events.
import asyncio, hashlib, json, os, re, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
# Путь БД переопределяем окружением (тесты пишут во временный файл).
DB = os.environ.get('TG_TURNOVER_DB') or (HERE + '/../invest/invest_portfolio.db')

sys.path.insert(0, HERE)
import importlib.util as _ilu
_tl = _ilu.spec_from_file_location('tg_login', os.path.join(HERE, 'tg_login.py'))
_l = None
if _tl is not None:
    _lum = _ilu.module_from_spec(_tl)
    try:
        _tl.loader.exec_module(_lum)
        _l = _lum
    except Exception:
        _l = None

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
    con.execute('''CREATE TABLE IF NOT EXISTS tariff_details(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT,
        source TEXT,
        ts_epoch INTEGER,
        msg_id INTEGER,
        payload_json TEXT,
        raw_md5 TEXT,
        UNIQUE(day, source))''')
    con.execute('CREATE INDEX IF NOT EXISTS idx_tariff_details_day ON tariff_details(day, source)')
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


TARIFF_SOURCES = (
    ("%Финам%", "finam"),
    ("%Т-Инвест%", "tinkoff"),
)

def tariff_source(chat):
    for like, src in TARIFF_SOURCES:
        if like.strip("%") in (chat or ""):
            return src
    return None

def parse_tariff(text, chat=None):
    """'Тариф процентный' из канала брокера -> структура один раз при приходе
    сообщения (P2). Итог сохраняется в tariff_details.payload_json (JSON),
    API читает таблицу и regex из 5с-цикла исключён."""
    if not text or "Тариф процентный" not in text:
        return None
    src = tariff_source(chat)
    if not src:
        return None
    tm = re.search(r"за\s+(\d{4}-\d{2}-\d{2})", text)
    if not tm:
        return None
    p = {"day": tm.group(1), "source": src}
    def _num(pat, val):
        m = re.search(pat, val)
        if not m:
            return None
        try:
            return float(re.sub(r"[^\d.]", "", m.group(1)))
        except ValueError:
            return None
    comm = _num(r"Комиссия\s*([\d' ]+?)₽", text)
    if comm is not None:
        p["commission"] = round(comm, 2)
    base = _num(r"при\s+базе\s*([\d' ]+?)₽", text)
    if base is not None:
        p["base"] = round(base, 2)
    sess = _num(r"сессия\s*([\d' ]+?)\s*\+", text)
    if sess is not None:
        p["session"] = round(sess, 2)
    eve = _num(r"вечер\s+прошлого\s+дня\s*([\d' ]+?)\)", text)
    if eve is not None:
        p["evening"] = round(eve, 2)
    mo = re.search(r"(\d+)\s+исполненных\s+поручени", text)
    if mo:
        p["orders"] = int(mo.group(1))
    mr = re.search(r"Ставка\s+([\d.]+)\s*%", text)
    if mr:
        p["rate_percent"] = float(mr.group(1))
    mf = re.search(r"([\d.,]+)₽\s+на\s+поручение", text)
    if mf:
        try:
            p["fee_per_order"] = float(mf.group(1).replace(",", "."))
        except ValueError:
            pass
    return p

def save_tariff(chat, msg_id, ts, text):
    """Upsert тарифа по (day, source); правка поста детектится по raw_md5."""
    p = parse_tariff(text, chat)
    if not p or not p.get("source") or not p.get("day"):
        return
    raw_md5 = hashlib.md5((text or "").encode("utf-8", "replace")).hexdigest()
    payload = json.dumps(p, ensure_ascii=False, sort_keys=True)
    con = _conn()
    existing = con.execute(
        'SELECT id, msg_id, raw_md5 FROM tariff_details'
        ' WHERE day=? AND source=?', (p["day"], p["source"])).fetchone()
    if existing:
        eid, old_msg_id, old_md5 = existing
        if int(msg_id) == old_msg_id and old_md5 == raw_md5:
            con.close(); return
        con.execute(
            'UPDATE tariff_details SET ts_epoch=?, msg_id=?, payload_json=?, raw_md5=? WHERE id=?',
            (int(ts), int(msg_id), payload, raw_md5, eid))
    else:
        con.execute(
            'INSERT INTO tariff_details (day, source, ts_epoch, msg_id, payload_json, raw_md5)'
            ' VALUES (?,?,?,?,?,?)',
            (p["day"], p["source"], int(ts), int(msg_id), payload, raw_md5))
    con.commit(); con.close()

def backfill_tariff(limit=100):
    """Одноразовое заполнение уже пришедших сообщений (первый старт после P2)."""
    con = _conn()
    rows = con.execute(
        'SELECT chat, msg_id, ts_epoch, text FROM bot_events'
        " WHERE text LIKE '%Тариф процентный%' ORDER BY ts_epoch DESC LIMIT ?",
        (limit,)).fetchall()
    n = 0
    for chat, msg_id, ts, text in rows:
        p = parse_tariff(text, chat)
        if not p or not p.get("source") or not p.get("day"):
            continue
        if con.execute('SELECT 1 FROM tariff_details WHERE day=? AND source=?',
                       (p["day"], p["source"])).fetchone():
            continue
        payload = json.dumps(p, ensure_ascii=False, sort_keys=True)
        con.execute(
            'INSERT INTO tariff_details (day, source, ts_epoch, msg_id, payload_json, raw_md5)'
            ' VALUES (?,?,?,?,?,?)',
            (p["day"], p["source"], int(ts), int(msg_id), payload,
             hashlib.md5((text or "").encode("utf-8", "replace")).hexdigest()))
        n += 1
    con.commit(); con.close()
    if n:
        print(f'💾 тариф: добавлено из bot_events: {n}', flush=True)
    return n

async def scan_channel(client, ent):
    """Читает свежие посты канала напрямую (без зеркала)."""
    title = ent.title or ''
    n = 0
    async for m in client.iter_messages(ent, limit=50):
        text = m.message or ''
        ts = int(m.date.timestamp()) if m.date else int(time.time())
        if m.id is not None:
            save_event(title, 'channel_post', m.id, ts, text)
            save_tariff(title, m.id, ts, text)
        p = parse(text) if text else None
        if p:
            save(m.id, ts, p, text)
            print(f"💾 {title}: оборот {p['turnover']:,.2f} капитал {p['capital']} ком {p.get('commission')} day={p['day']}", flush=True)
            n += 1
    if n:
        print(f'  -> новых/обновлённых записей: {n}', flush=True)

async def main():
    from telethon import TelegramClient

    print('🔄 tg_turnover_daemon start (прямое чтение каналов, без зеркала)', flush=True)
    if _l is None:
        print('Нет tg_login.py (сессия) — демон завершён', flush=True)
        return
    init_db()
    backfill_tariff()
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