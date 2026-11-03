#!/usr/bin/env python3
"""invest_tokens.py — безопасное управление токенами брокеров.

Зачем: токены не должны попадать в чат/LLM, в историю shell, в `ps` и в git.
Скрипт читает токен только через stdin без эха (getpass), пишет его в `.env`
(файл в .gitignore) и хранит в реестре `parsers/invest/sources.json` лишь
ИМЕНА переменных окружения, без секретов.

Команды:
  add <id> [--label "С3 TRND"] [--interval 60]   добавить/обновить источник
  list                                           список (токены замаскированы)
  check <id>                                     проверить токен у брокера
  remove <id>                                    удалить источник и его env-ключи

Токен НИКОГДА не передаётся аргументом: только интерактивный ввод или stdin.

Примеры:
  python sh/invest_tokens.py add trnd --label "С3 TRND"
  python sh/invest_tokens.py list
  python sh/invest_tokens.py check trnd
  python sh/invest_tokens.py remove trnd

Внимание: если токен уже публиковался (чат, скриншот, лог) — перевыпустите его
в кабинете брокера, старый считайте скомпрометированным.
"""
import argparse
import getpass
import http.client
import json
import os
import re
import ssl
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
REGISTRY_PATH = ROOT / "parsers" / "invest" / "sources.json"

HOST = "invest-public-api.tbank.ru"
EP_ACCOUNTS = "/rest/tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts"
EP_PORTFOLIO = "/rest/tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio"

ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,15}$")
TOKEN_RE = re.compile(r"^t\.[A-Za-z0-9_\-]{20,}$")


# --------------------------------------------------------------------------
# .env
# --------------------------------------------------------------------------
def read_env():
    if not ENV_PATH.exists():
        return []
    with open(ENV_PATH, "r", encoding="utf-8") as f:
        return f.read().splitlines()


def write_env(lines):
    tmp = ENV_PATH.with_suffix(".env.tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines).rstrip("\n") + "\n")
    os.replace(tmp, ENV_PATH)
    # На POSIX — только владельцу. На Windows chmod частично поддерживается.
    try:
        os.chmod(ENV_PATH, 0o600)
    except OSError:
        pass


def env_set(lines, key, value):
    prefix = key + "="
    for i, line in enumerate(lines):
        if line.startswith(prefix):
            lines[i] = f"{key}={value}"
            return lines
    lines.append(f"{key}={value}")
    return lines


def env_unset(lines, key):
    return [ln for ln in lines if not ln.startswith(key + "=")]


def env_get(key):
    for line in read_env():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


# --------------------------------------------------------------------------
# Реестр источников (без секретов)
# --------------------------------------------------------------------------
def load_registry():
    if REGISTRY_PATH.exists():
        try:
            with open(REGISTRY_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("sources"), list):
                return data
        except (OSError, ValueError) as e:
            print(f"⚠️  sources.json не прочитан: {e}")
    return {"sources": []}


def save_registry(data):
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = REGISTRY_PATH.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, REGISTRY_PATH)


def registry_entry(source_id):
    for s in load_registry().get("sources", []):
        if s.get("id") == source_id:
            return s
    return None


def env_names(source_id):
    """Имена переменных окружения для источника (по умолчанию <ID>_*)."""
    entry = registry_entry(source_id) or {}
    up = source_id.upper()
    return (
        entry.get("token_env") or f"{up}_TOKEN",
        entry.get("account_env") or f"{up}_ACCOUNT_ID",
        entry.get("interval_env") or f"{up}_UPDATE_INTERVAL_SEC",
    )


# --------------------------------------------------------------------------
# Брокер
# --------------------------------------------------------------------------
def _post(endpoint, payload, token, timeout=25):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    conn = http.client.HTTPSConnection(HOST, timeout=timeout, context=ctx)
    try:
        conn.request("POST", endpoint, json.dumps(payload),
                     {"Content-Type": "application/json",
                      "Authorization": "Bearer " + token})
        res = conn.getresponse()
        body = res.read().decode()
        return res.status, body
    finally:
        conn.close()


def fetch_accounts(token):
    st, body = _post(EP_ACCOUNTS, {}, token)
    if st != 200:
        raise RuntimeError(f"GetAccounts HTTP {st}: {body[:160]}")
    return json.loads(body).get("accounts") or []


def fetch_total(token, account_id):
    st, body = _post(EP_PORTFOLIO, {"accountId": account_id, "currency": "RUB"}, token)
    if st != 200:
        raise RuntimeError(f"GetPortfolio HTTP {st}: {body[:160]}")
    d = json.loads(body)
    q = d.get("totalAmountPortfolio") or {}
    return float(q.get("units", 0)) + float(q.get("nano", 0)) / 1e9


def mask(token):
    if not token:
        return "—"
    if len(token) <= 10:
        return token[:2] + "***"
    return f"{token[:4]}…{token[-2:]} (len {len(token)})"


def read_token_interactive():
    """Токен без эха. Если stdin не терминал — читаем строку из stdin."""
    if sys.stdin.isatty():
        tok = getpass.getpass("Токен (ввод не отображается): ").strip()
    else:
        tok = sys.stdin.readline().strip()
    return tok


# --------------------------------------------------------------------------
# Команды
# --------------------------------------------------------------------------
def cmd_add(args):
    sid = args.id.strip().lower()
    if not ID_RE.match(sid):
        print("❌ id: латиница в нижнем регистре, 2–16 символов (например trnd)")
        return 2

    token = read_token_interactive()
    if not token:
        print("❌ Токен не введён")
        return 2
    if not TOKEN_RE.match(token):
        print("⚠️  Токен не похож на T-Invest (`t.…`), но продолжаю")

    try:
        accounts = fetch_accounts(token)
    except Exception as e:
        print(f"❌ Токен не принят брокером: {e}")
        return 1

    if not accounts:
        print("❌ У токена нет доступных счетов")
        return 1

    # Выбор счёта: один — берём сразу, несколько — по номеру.
    account_id = args.account or ""
    if not account_id:
        if len(accounts) == 1:
            account_id = accounts[0].get("id", "")
        else:
            print("Доступные счета:")
            for i, a in enumerate(accounts, 1):
                print(f"  {i}. {a.get('name')} · {a.get('id')} · {a.get('type')}")
            try:
                pick = int(input("Номер счёта: ").strip())
                account_id = accounts[pick - 1].get("id", "")
            except (ValueError, IndexError):
                print("❌ Некорректный выбор")
                return 2

    accounts = fetch_accounts(token)  # повторная проверка перед записью
    if account_id not in [a.get("id") for a in accounts]:
        print("❌ Счёт не принадлежит этому токену")
        return 1

    token_env, account_env, interval_env = env_names(sid)
    label = args.label or sid.upper()
    interval = str(args.interval or 60)

    lines = read_env()
    lines = env_set(lines, token_env, token)
    lines = env_set(lines, account_env, account_id)
    lines = env_set(lines, interval_env, interval)
    write_env(lines)

    reg = load_registry()
    sources = [s for s in reg.get("sources", []) if s.get("id") != sid]
    sources.append({
        "id": sid,
        "label": label,
        "broker": "tinkoff",
        "token_env": token_env,
        "account_env": account_env,
        "interval_env": interval_env,
    })
    sources.sort(key=lambda s: s.get("id", ""))
    reg["sources"] = sources
    save_registry(reg)

    try:
        total = fetch_total(token, account_id)
        total_str = f"{total:,.2f} ₽".replace(",", " ")
    except Exception:
        total_str = "н/д"

    print(f"✅ Источник «{label}» ({sid}) добавлен")
    print(f"   счёт: {account_id} · капитал: {total_str}")
    print(f"   .env: {token_env} = {mask(token)}")
    print("   Реестр: parsers/invest/sources.json (без секретов)")
    return 0


def cmd_list(_args):
    reg = load_registry()
    sources = reg.get("sources", [])
    if not sources:
        print("Источников нет. Добавьте: python sh/invest_tokens.py add <id>")
        return 0
    print(f"{'id':<10}{'label':<14}{'счёт':<14}{'токен':<22}{'интервал'}")
    for s in sources:
        sid = s.get("id", "")
        token_env, account_env, interval_env = env_names(sid)
        token = env_get(token_env)
        print(f"{sid:<10}{s.get('label',''):<14}{env_get(account_env):<14}{mask(token):<22}{env_get(interval_env) or '—'}")
    return 0


def cmd_check(args):
    sid = args.id.strip().lower()
    token_env, account_env, _ = env_names(sid)
    token = env_get(token_env)
    account = env_get(account_env)
    if not token:
        print(f"❌ {token_env} не найден в .env")
        return 2
    try:
        accounts = fetch_accounts(token)
        print(f"✅ Токен валиден · счетов: {len(accounts)}")
        for a in accounts:
            mark = " ←" if a.get("id") == account else ""
            print(f"   · {a.get('name')} · {a.get('id')} · {a.get('type')}{mark}")
        if account:
            print(f"   капитал: {fetch_total(token, account):,.2f} ₽".replace(",", " "))
        else:
            print("⚠️  счёт не задан в .env")
    except Exception as e:
        print(f"❌ {e}")
        return 1
    return 0


def cmd_remove(args):
    sid = args.id.strip().lower()
    token_env, account_env, interval_env = env_names(sid)

    lines = read_env()
    for key in (token_env, account_env, interval_env):
        lines = env_unset(lines, key)
    write_env(lines)

    reg = load_registry()
    before = len(reg.get("sources", []))
    reg["sources"] = [s for s in reg.get("sources", []) if s.get("id") != sid]
    save_registry(reg)

    removed_env = before != len(reg["sources"])
    print(f"✅ Источник «{sid}» удалён" if removed_env else f"⚠️  «{sid}» не найден в реестре")
    print(f"   .env: удалены {token_env}, {account_env}, {interval_env}")
    print("   Данные в БД за этим источником остаются (source='" + sid + "')")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description="Безопасное управление токенами брокеров")
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add", help="добавить/обновить источник")
    a.add_argument("id")
    a.add_argument("--label", default="")
    a.add_argument("--interval", type=int, default=60)
    a.add_argument("--account", default="", help="id счёта (иначе выбор из списка)")
    a.set_defaults(func=cmd_add)

    l = sub.add_parser("list", help="список источников (токены замаскированы)")
    l.set_defaults(func=cmd_list)

    c = sub.add_parser("check", help="проверить токен у брокера")
    c.add_argument("id")
    c.set_defaults(func=cmd_check)

    r = sub.add_parser("remove", help="удалить источник и его env-ключи")
    r.add_argument("id")
    r.set_defaults(func=cmd_remove)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
