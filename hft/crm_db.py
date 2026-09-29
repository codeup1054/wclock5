# crm_db.py — БД CRM для HFT: пользователи, роли, сессии, доступ к панелям
import os
import sqlite3
import secrets
import hashlib
from datetime import datetime, timedelta, timezone

BASE_DIR = os.path.dirname(__file__)
DB_PATH = os.path.join(BASE_DIR, "crm", "hft_crm.db")

PANELS = [
    "capital",
    "turnover",
    "tickers",
    "feed",
    "report",
    "chart",
    "weather",
    "clock",
    "crm",
]

ROLE_DEFAULTS = {
    "admin": PANELS,
    "user": ["capital", "turnover", "feed"],
}


def connect(db_path=None):
    conn = sqlite3.connect(db_path or DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000)
    return f"{salt}${digest.hex()}"


def _verify_password(password, stored):
    try:
        salt, _ = stored.split("$", 1)
    except ValueError:
        return False
    return secrets.compare_digest(_hash_password(password, salt), stored)


def init_db(db_path=None):
    conn = connect(db_path)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            tg TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            last_login TEXT
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS panel_access (
            user_id INTEGER NOT NULL REFERENCES users(id),
            panel TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS panel_layouts (
            user_id INTEGER PRIMARY KEY REFERENCES users(id),
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_panel_user ON panel_access(user_id);
    """)
    conn.commit()
    # seed админа из env (если таблица пуста)
    cur = conn.execute("SELECT COUNT(*) AS n FROM users")
    if cur.fetchone()["n"] == 0:
        username = os.environ.get("HFT_ADMIN_USER", "admin")
        password = os.environ.get("HFT_ADMIN_PASS") or secrets.token_urlsafe(12)
        create_user(conn, username, password, role="admin",
                    panels=ROLE_DEFAULTS["admin"], tg=os.environ.get("HFT_ADMIN_TG", "@codeup1054"))
        print(f"👤 Создан админ: {username} (пароль в env, tg={os.environ.get('HFT_ADMIN_TG','@codeup1054')})", flush=True)
        if not os.environ.get("HFT_ADMIN_PASS"):
            print(f"🔑 НЕ задан HFT_ADMIN_PASS — сгенерирован: {password}", flush=True)
    conn.close()


def create_user(conn, username, password, role="user", panels=None, tg=""):
    now = datetime.now(timezone.utc).isoformat()
    cur = conn.execute(
        "INSERT INTO users (username, password_hash, role, tg, created_at) VALUES (?,?,?,?,?)",
        (username, _hash_password(password), role, tg, now))
    uid = cur.lastrowid
    set_panels(conn, uid, panels if panels is not None else ROLE_DEFAULTS.get(role, ROLE_DEFAULTS["user"]))
    conn.commit()
    return uid


def update_user(conn, uid, password=None, role=None, panels=None, tg=None):
    user = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not user:
        return None
    if password:
        conn.execute("UPDATE users SET password_hash=? WHERE id=?", (_hash_password(password), uid))
    if role:
        conn.execute("UPDATE users SET role=? WHERE id=?", (role, uid))
    if tg is not None:
        conn.execute("UPDATE users SET tg=? WHERE id=?", (tg, uid))
    if panels is not None:
        set_panels(conn, uid, panels)
    conn.commit()
    return get_user(conn, uid)


def set_panels(conn, uid, panels):
    conn.execute("DELETE FROM panel_access WHERE user_id=?", (uid,))
    for p in panels:
        if p in PANELS:
            conn.execute("INSERT INTO panel_access (user_id, panel) VALUES (?,?)", (uid, p))


def get_user(conn, uid):
    user = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not user:
        return None
    panels = [r["panel"] for r in conn.execute(
        "SELECT panel FROM panel_access WHERE user_id=? ORDER BY panel", (uid,)).fetchall()]
    d = dict(user)
    d["panels"] = panels
    return d


def get_user_by_name(conn, username):
    user = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    return dict(user) if user else None


def auth(conn, username, password):
    user = get_user_by_name(conn, username)
    if not user or not _verify_password(password, user["password_hash"]):
        return None
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    conn.execute("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)",
                 (token, user["id"], now.isoformat(), (now + timedelta(days=7)).isoformat()))
    conn.execute("UPDATE users SET last_login=? WHERE id=?", (now.isoformat(), user["id"]))
    conn.commit()
    return token, get_user(conn, user["id"])


def session_user(conn, token):
    if not token:
        return None
    row = conn.execute(
        "SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?",
        (token,)).fetchone()
    if not row:
        return None
    if datetime.fromisoformat(row["expires_at"]) < datetime.now(timezone.utc):
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))
        conn.commit()
        return None
    return get_user(conn, row["id"])


def logout(conn, token):
    if token:
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))
        conn.commit()


def list_users(conn):
    users = []
    for u in conn.execute("SELECT * FROM users ORDER BY id").fetchall():
        users.append(get_user(conn, u["id"]))
    return users


def get_layout(conn, uid):
    """Раскладка панелей пользователя (JSON-строка) или None."""
    row = conn.execute(
        "SELECT data FROM panel_layouts WHERE user_id=?", (uid,)).fetchone()
    return row["data"] if row else None


def set_layout(conn, uid, data):
    """Сохранить раскладку панелей пользователя (data — JSON-строка)."""
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO panel_layouts (user_id, data, updated_at) VALUES (?,?,?)"
        " ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
        (uid, data, now))
    conn.commit()