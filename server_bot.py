#!/usr/bin/env python3
"""beget_admin_bot — server monitoring Telegram bot"""
import urllib.request, urllib.error, json, subprocess, threading, time, os, signal, sys, textwrap, tempfile

TOKEN = "8968035418:AAFBcJpPmSSRHLJgCooRSC0JsCIODXprP6k"
API = f"https://api.telegram.org/bot{TOKEN}"
CHAT_ID = None
running = True

SETTINGS_FILE = "/etc/server_bot_settings.json"
DEFAULT_SETTINGS = {
    "brief_interval": 360,
    "disk_alert_pct": 85,
    "mem_alert_pct": 90,
    "cpu_alert_load": 2.0,
    "alerts_enabled": True,
}
settings = dict(DEFAULT_SETTINGS)
last_brief_time = 0

# conversation state: {chat_id: {"awaiting": "setting_key", "param": "..."}}
conv = {}

def load_settings():
    global settings
    try:
        with open(SETTINGS_FILE) as f:
            saved = json.load(f)
            settings.update(saved)
    except:
        save_settings()

def save_settings():
    try:
        with open(SETTINGS_FILE, "w") as f:
            json.dump(settings, f, indent=2)
    except:
        pass

load_settings()

def tg(method, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(f"{API}/{method}", data=data,
        headers={"Content-Type": "application/json"})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=10).read())
    except Exception as e:
        return {"ok": False, "error": str(e)}

def send(text, chat=None, keyboard=None):
    payload = {"chat_id": chat or CHAT_ID, "text": text, "parse_mode": "HTML"}
    if keyboard:
        payload["reply_markup"] = json.dumps({"keyboard": keyboard, "resize_keyboard": True})
    tg("sendMessage", payload)

def send_file(filepath, caption="", chat=None):
    chat = chat or CHAT_ID
    boundary = "----FormBoundary7MA4YW"
    with open(filepath, "rb") as f:
        file_data = f.read()
    filename = os.path.basename(filepath)
    parts = []
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n{chat}")
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"caption\"\r\n\r\n{caption}")
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="document"; filename="{filename}"\r\nContent-Type: text/plain\r\n\r\n')
    body = "\r\n".join(parts).encode() + file_data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{API}/sendDocument", data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        urllib.request.urlopen(req, timeout=30)
    except:
        pass

DOCKER = "/usr/bin/docker"

def shell(cmd):
    try:
        return subprocess.check_output(cmd, shell=True, stderr=subprocess.STDOUT, timeout=15).decode().strip()
    except:
        return "\u2014"

def tag(s, ok=True):
    return "\u2705" if ok else "\u274c"

def cmd_brief():
    used, total, pct, free = shell("df -h / | tail -1 | awk '{print $3, $2, $5, $4}'").split()
    mem_u, mem_t = shell("free -h | awk '/Mem/ {print $3, $2}'").split()
    upt = shell("uptime -p")
    now_str = time.strftime("%H:%M %d.%m.%Y")
    return (
        f"<b>\U0001f4e1 wclock5</b>  <code>{now_str}</code>\n"
        f"\U0001f4be Disk:    <code>{used}/{total}</code> ({pct})\n"
        f"\U0001f9e0 Memory:  <code>{mem_u}/{mem_t}</code>\n"
        f"\u23f1 Uptime:  <code>{upt}</code>"
    )

def cmd_status():
    used, total, pct, free = shell("df -h / | tail -1 | awk '{print $3, $2, $5, $4}'").split()
    mem_u, mem_t = shell("free -h | awk '/Mem/ {print $3, $2}'").split()
    swp_u, swp_t = shell("free -h | awk '/Swap/ {print $3, $2}'").split()
    l1, l2, l3 = shell("cat /proc/loadavg | awk '{print $1, $2, $3}'").split()
    upt = shell("uptime -p")
    top = shell("ps aux --sort=-%mem | head -6 | awk 'NR>1 {printf \"%s %.1f%%\\n\", $11, $4}'")
    top_lines = [line for line in top.split("\n") if line.strip()][:5]
    conts = shell(f"{DOCKER} ps --format '{{{{.Names}}}}: {{{{.Status}}}}' 2>/dev/null") or ""
    cont_lines = [line for line in conts.split("\n") if line.strip()][:10]
    ngx = shell("systemctl is-active nginx 2>/dev/null")
    out = ["<b>\U0001f4ca Server Status</b>", "\u250f\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501"]
    out.append(f"\u2503 \U0001f4be Disk:     {used}/{total} ({pct})")
    out.append(f"\u2503 \U0001f9e0 Memory:   {mem_u}/{mem_t}")
    out.append(f"\u2503 \U0001f4e5 Swap:     {swp_u}/{swp_t}")
    out.append(f"\u2503 \U0001f4c8 Load:     {l1}  {l2}  {l3}")
    out.append(f"\u2503 \u23f1 Uptime:   {upt}")
    out.append("\u2523\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501")
    out.append(f"\u2503 <b>\U0001f3c6 Top processes</b>")
    for i, line in enumerate(top_lines[:5]):
        pref = "\u2517" if i == len(top_lines[:5]) - 1 else "\u2523"
        out.append(f"{pref}\u2501\u2501 {line}")
    out.append("\u2523\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501")
    out.append(f"\u2503 <b>\U0001f433 Docker</b>")
    for i, line in enumerate(cont_lines):
        pref = "\u2517" if i == len(cont_lines) - 1 else "\u2523"
        out.append(f"{pref}\u2501\u2501 {line}")
    if not cont_lines:
        out.append(f"\u2517\u2501\u2501 \u2014")
    out.append("\u2523\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501")
    out.append(f"\u2503 \U0001f310 Nginx:    {tag(ngx=='active')} <code>{ngx}</code>")
    out.append("\u2517\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501")
    return "\n".join(out)

def cmd_cleanup():
    d1 = shell(f"{DOCKER} builder prune -f 2>&1 | tail -1")
    d2 = shell(f"{DOCKER} image prune -a -f 2>&1 | tail -1")
    jl = shell("journalctl --vacuum-size=150M 2>&1 | tail -1")
    shell("rm -f /tmp/*.sql /tmp/*.json /tmp/*.tar.gz 2>/dev/null")
    free = shell("df -h / | tail -1 | awk '{print $4}'")
    pct = shell("df -h / | tail -1 | awk '{print $5}'")
    return (
        "<b>\U0001f9f9 Cleanup</b>\n"
        "\u250f\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n"
        f"\u2503 \U0001f433 Docker: <code>{d1}</code>\n"
        f"\u2503 \U0001f433 Docker: <code>{d2}</code>\n"
        f"\u2503 \U0001f4dd Journal: <code>{jl}</code>\n"
        f"\u2503 \U0001f4c4 Tmp:    <code>cleaned</code>\n"
        "\u2523\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n"
        f"\u2503 \U0001f4be Free:   <code>{free}</code> ({pct})\n"
        "\u2517\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501"
    )

def cmd_services():
    svcs = []
    for s in ["nginx", "cron", "ssh", "docker"]:
        st = shell(f"systemctl is-active {s} 2>/dev/null")
        svcs.append(f"\u2523\u2501\u2501 {s}: {tag(st=='active')} <code>{st}</code>")
    conts = shell(f"{DOCKER} ps --format '{{{{.Names}}}}: {{{{.Status}}}}' 2>/dev/null") or ""
    cont_lines = [line for line in conts.split("\n") if line.strip()][:10]
    out = ["<b>\U0001f6e1 Services</b>", "\u250f\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501"]
    out.extend(svcs)
    if cont_lines:
        out.append(f"\u2523\u2501\u2501 <b>\U0001f433 Containers</b>")
        for i, line in enumerate(cont_lines):
            pref = "\u2517" if i == len(cont_lines) - 1 else "\u2523"
            out.append(f"\u2502  {pref}\u2501\u2501 {line}")
    out.append("\u2517\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501")
    return "\n".join(out)

def cmd_df():
    total, used, pct = shell("df -h / | tail -1 | awk '{print $2, $3, $5}'").split()
    # top dirs
    raw = shell("du -sh /* 2>/dev/null | sort -rh | head -10")
    lines = [l for l in raw.split("\n") if l.strip()]
    out = ["<b>\U0001f4be Disk Tree</b>",
        f"<b>/</b>  <code>{used}/{total}</code> ({pct})"]
    for l in lines:
        size, path = l.split("\t", 1)
        name = path.split("/")[-1]
        # get 2 sub-items for top 5 dirs
        subs = shell(f"du -sh {path}/* 2>/dev/null | sort -rh | head -3")
        sub_lines = [s for s in subs.split("\n") if s.strip()]
        out.append(f"\u2523\u2501\u2501 {name}  <code>{size}</code>")
        for si, sl in enumerate(sub_lines[:3]):
            sz, sp = sl.split("\t", 1)
            sn = sp.split("/")[-1]
            pref = "\u2517" if si == min(len(sub_lines[:3])-1, 2) else "\u2523"
            out.append(f"\u2502  {pref}\u2501\u2501 {sn}  <code>{sz}</code>")
    return "\n".join(out)

def cmd_sites():
    www = shell("ls -d /var/www/*/ 2>/dev/null | sed 's|/var/www/||;s|/||'")
    dirs = [d for d in www.split("\n") if d.strip() and d not in ("html", "beget_infra", "docs", "init_site.sh")]
    ngx = set(shell("ls /etc/nginx/sites-enabled/ 2>/dev/null").split())
    out = [f"<b>\U0001f310 Sites</b> ({len(dirs)})"]
    for i, d in enumerate(sorted(dirs)):
        disk = shell(f"du -sh /var/www/{d} 2>/dev/null | awk '{{print $1}}'")
        # check nginx config: exact name, or <name>.conf, or <name>.startupassist.ru
        in_nginx = any(d in cfg or cfg.replace(".conf","") in d or f"{d}.startupassist.ru" in cfg for cfg in ngx)
        ok = "\u2705" if in_nginx else "\u26d4"
        # ssl: check letsencrypt live dir with matching name
        ssl_found = shell(f"ls /etc/letsencrypt/live/{d}/fullchain.pem 2>/dev/null || ls /etc/letsencrypt/live/{d}.startupassist.ru/fullchain.pem 2>/dev/null || echo -")
        if ssl_found and ssl_found != "-":
            ssl_domain = d
            # try to find the right domain for the cert
            for candidate in [d, f"{d}.startupassist.ru", d.replace(".startupassist.ru","")]:
                p = f"/etc/letsencrypt/live/{candidate}/fullchain.pem"
                if shell(f"test -f {p} && echo 1") == "1":
                    ssl_domain = candidate
                    break
            expiry = shell(f"openssl x509 -enddate -noout -in /etc/letsencrypt/live/{ssl_domain}/fullchain.pem 2>/dev/null | cut -d= -f2")
            days_str = shell(f"echo '{expiry}' | python3 -c \"import sys; from datetime import datetime; d=datetime.strptime(sys.stdin.read().strip(),'%b %d %H:%M:%S %Y %Z'); print((d-datetime.now()).days)\" 2>/dev/null")
            if days_str and days_str.lstrip("-").isdigit():
                dd = int(days_str)
                ssl_icon = "\u2705" if dd > 14 else ("\u26a0\ufe0f" if dd > 0 else "\u274c")
                ssl_txt = f"{dd}d" if dd > 0 else f"-{abs(dd)}d"
            else:
                ssl_icon, ssl_txt = "\u2753", "?"
        else:
            ssl_icon, ssl_txt = "\u26d4", "nossl"
        line = f"<code>{i:02d}</code>  {ok} {ssl_icon}  <code>{ssl_txt:>5}</code>  \U0001f4be<code>{disk:>4}</code>  {d}"
        out.append(line)
    return "\n".join(out)

def cmd_top(n=8):
    n1 = n + 1
    rows = shell("ps aux --sort=-%%mem | head -%d | awk 'NR>1 {printf \"%%.1f%%%%  %%s\\n\", $4, $11}'" % n1)
    lines = [l for l in rows.split("\n") if l.strip()][:n]
    out = ["<b>\U0001f3c6 Top Processes</b>", "\u250f\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501"]
    for i, l in enumerate(lines):
        pref = "\u2517" if i == len(lines) - 1 else "\u2523"
        out.append(f"{pref}\u2501\u2501 {l}")
    out.append("\u2517\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501")
    return "\n".join(out)

KB = [
    ["/brief", "/status"],
    ["/sites", "/services"],
    ["/du", "/cleanup", "/df"],
    ["/settings", "/logfile", "/uptime"],
    ["/logs", "/help"],
]

def cmd_help():
    lines = [
        "<b>\U0001f916 Beget Admin Bot</b>",
        "/brief \u2014 \u043a\u0440\u0430\u0442\u043a\u0430\u044f \u0441\u0432\u043e\u0434\u043a\u0430",
        "/status \u2014 \u043f\u043e\u0434\u0440\u043e\u0431\u043d\u044b\u0439 \u0441\u0442\u0430\u0442\u0443\u0441",
        "/cleanup \u2014 \u043e\u0447\u0438\u0441\u0442\u043a\u0430 \u0434\u0438\u0441\u043a\u0430",
        "/services \u2014 \u0441\u0442\u0430\u0442\u0443\u0441 \u0441\u0435\u0440\u0432\u0438\u0441\u043e\u0432",
        "/sites \u2014 \u0441\u0430\u0439\u0442\u044b \u0438 \u0441\u0442\u0430\u0442\u0443\u0441",
        "/df \u2014 \u0434\u0438\u0441\u043a\u0438",
        "/top \u2014 \u0442\u043e\u043f \u043f\u0440\u043e\u0446\u0435\u0441\u0441\u043e\u0432",
        "/du \u2014 \u0440\u0430\u0437\u043c\u0435\u0440 \u043f\u0430\u043f\u043a\u0438 \u0441\u0430\u0439\u0442\u0430",
        "/settings \u2014 \u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438 \u0438 \u0430\u043b\u0435\u0440\u0442\u044b",
        "/uptime \u2014 \u0430\u043f\u0442\u0430\u0439\u043c",
        "/logs \u2014 \u043f\u043e\u0441\u043b\u0435\u0434\u043d\u0438\u0435 \u043e\u0448\u0438\u0431\u043a\u0438",
        "/logfile \u2014 \u0444\u0430\u0439\u043b \u043b\u043e\u0433\u043e\u0432 \u0437\u0430 \u0447\u0430\u0441",
        "/help \u2014 \u044d\u0442\u043e \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435"
    ]
    return "\n".join(lines), KB

def cmd_settings():
    s = settings
    status = "\u2705" if s["alerts_enabled"] else "\u274c"
    mins = s["brief_interval"]
    h = mins // 60
    m = mins % 60
    interval_str = f"{h}h {m}m" if h else f"{m}m"
    return (
        "<b>\u2699\ufe0f Settings</b>\n"
        "\u250f\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n"
        f"\u2503 \u23f0 Report:  <code>{interval_str}</code>\n"
        f"\u2503 \U0001f4be Disk:    <code>&gt;{s['disk_alert_pct']}%</code>\n"
        f"\u2503 \U0001f9e0 Memory:  <code>&gt;{s['mem_alert_pct']}%</code>\n"
        f"\u2503 \U0001f4c8 CPU:     <code>&gt;{s['cpu_alert_load']}</code> (load)\n"
        f"\u2503 \U0001f514 Alerts:  {status}\n"
        "\u2523\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n"
        "\u2503 \u0418\u0437\u043c\u0435\u043d\u0438\u0442\u044c:\n"
        "\u2503 <code>1</code> \u2014 \u0438\u043d\u0442\u0435\u0440\u0432\u0430\u043b (\u043c\u0438\u043d\u0443\u0442\u044b)\n"
        "\u2503 <code>2</code> \u2014 \u043f\u043e\u0440\u043e\u0433 \u0434\u0438\u0441\u043a\u0430 (%)\n"
        "\u2503 <code>3</code> \u2014 \u043f\u043e\u0440\u043e\u0433 RAM (%)\n"
        "\u2503 <code>4</code> \u2014 \u043f\u043e\u0440\u043e\u0433 CPU (load)\n"
        "\u2503 <code>5</code> \u2014 \u0432\u043a\u043b/\u0432\u044b\u043a\u043b \u0430\u043b\u0435\u0440\u0442\u044b\n"
        "\u2517\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n"
        "\u041d\u0430\u043f\u0440\u0438\u043c\u0435\u0440: <code>1 30</code> (\u0438\u043d\u0442\u0435\u0440\u0432\u0430\u043b 30\u043c\u0438\u043d)"
    ), KB, "settings"

def handle_settings_text(text, chat):
    text = text.strip()
    parts = text.split()
    if len(parts) < 2:
        del conv[chat]
        return False
    try:
        idx = int(parts[0])
        val = parts[1]
    except:
        del conv[chat]
        return False

    mapping = {1: "brief_interval", 2: "disk_alert_pct", 3: "mem_alert_pct", 4: "cpu_alert_load"}
    labels = {1: "\u0438\u043d\u0442\u0435\u0440\u0432\u0430\u043b (\u043c\u0438\u043d)", 2: "\u043f\u043e\u0440\u043e\u0433 \u0434\u0438\u0441\u043a\u0430 (%)",
              3: "\u043f\u043e\u0440\u043e\u0433 RAM (%)", 4: "\u043f\u043e\u0440\u043e\u0433 CPU (load)"}

    if idx == 5:
        settings["alerts_enabled"] = not settings["alerts_enabled"]
        save_settings()
        onoff = "\u0432\u043a\u043b\u044e\u0447\u0435\u043d\u044b" if settings["alerts_enabled"] else "\u043e\u0442\u043a\u043b\u044e\u0447\u0435\u043d\u044b"
        send(f"\u2705 \u0410\u043b\u0435\u0440\u0442\u044b {onoff}", chat, keyboard=KB)
        del conv[chat]
        return True

    if idx not in mapping:
        del conv[chat]
        return False

    setting_key = mapping[idx]
    try:
        if setting_key in ("disk_alert_pct", "mem_alert_pct", "brief_interval"):
            settings[setting_key] = int(val)
        elif setting_key == "cpu_alert_load":
            settings[setting_key] = float(val)
    except:
        send(f"\u274c \u041d\u0435\u0432\u0435\u0440\u043d\u043e\u0435 \u0437\u043d\u0430\u0447\u0435\u043d\u0438\u0435", chat, keyboard=KB)
        del conv[chat]
        return True

    save_settings()
    send(f"\u2705 {labels[idx]} = <code>{val}</code>", chat, keyboard=KB)
    del conv[chat]
    return True

def cmd_uptime():
    upt = shell("uptime -p")
    up2 = shell("uptime")
    l1, l2, l3 = shell("cat /proc/loadavg | awk '{print $1, $2, $3}'").split()
    return (
        "<b>\u23f1 Uptime</b>\n"
        "\u250f\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n"
        f"\u2503 <code>{upt}</code>\n"
        f"\u2503 \U0001f4c8 Load: {l1}  {l2}  {l3}\n"
        f"\u2503 \U0001f4c5 Since: {up2.split('up')[0].strip()}\n"
        "\u2517\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501"
    )

def cmd_logs():
    return _logs_text()

def cmd_logfile():
    raw = shell("journalctl -n 500 --no-pager --since '1 hour ago' 2>/dev/null")
    if not raw or raw == "\u2014":
        return "\u2014", None
    tmp = os.path.join(tempfile.gettempdir(), "server_logs_1h.txt")
    with open(tmp, "w") as f:
        f.write(f"# Server logs (last hour) - {time.strftime('%H:%M %d.%m.%Y')}\n# Total: {len(raw.split(chr(10)))} lines\n\n{raw}")
    return "", tmp

def _logs_text():
    logs = shell("journalctl -n 8 --no-pager -p err --since '24 hours ago' 2>/dev/null | tail -8") or "\u2014"
    lines = [l for l in logs.split("\n") if l.strip()][:8]
    out = ["<b>\U0001f4dd Recent Errors</b> (24h)", "\u250f\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501"]
    for i, l in enumerate(lines):
        pref = "\u2517" if i == len(lines) - 1 else "\u2523"
        out.append(f"{pref}\u2501\u2501 <code>{l[:80]}</code>")
    out.append("\u2517\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501")
    return "\n".join(out)

def cmd_du(text=""):
    args = text.strip().split()
    if len(args) < 2:
        return "<b>\U0001f4be du</b>\n\u0418\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u043d\u0438\u0435: <code>/du \u0438\u043c\u044f_\u0441\u0430\u0439\u0442\u0430</code>"
    site = args[1].replace("/", "")
    # check /var/www/<site> and /var/www/<site>.startupassist.ru
    paths = [f"/var/www/{site}"]
    if not site.endswith(".startupassist.ru"):
        paths.append(f"/var/www/{site}.startupassist.ru")
    if site.count(".") == 0:
        paths.append(f"/var/www/{site}.ru")
    found = None
    for p in paths:
        if shell(f"test -d {p} && echo 1") == "1":
            found = p
            break
    if not found:
        return f"\u274c \u041f\u0430\u043f\u043a\u0430 <code>{site}</code> \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430"
    size = shell(f"du -sh {found} 2>/dev/null | awk '{{print $1}}'")
    raw = shell(f"du -sh {found}/* 2>/dev/null | sort -rh")
    items = [l for l in raw.split("\n") if l.strip()][:15]
    out = [f"<b>\U0001f4be {site}</b>  <code>{size}</code>"]
    for i, l in enumerate(items):
        sz, name = l.split("\t", 1)
        short = name.replace(found, "").lstrip("/")
        out.append(f"\u2523\u2501\u2501 {short}  <code>{sz}</code>")
    if not items:
        out.append("\u2523\u2501\u2501 (\u043f\u0443\u0441\u0442\u043e)")
    return "\n".join(out)

COMMANDS = {
    "/brief": (cmd_brief, None, None),
    "/status": (cmd_status, None, None),
    "/cleanup": (cmd_cleanup, None, None),
    "/services": (cmd_services, None, None),
    "/sites": (cmd_sites, None, None),
    "/df": (cmd_df, None, None),
    "/top": (cmd_top, None, None),
    "/du": (cmd_du, None, "args"),
    "/settings": (cmd_settings, KB, "settings"),
    "/help": (cmd_help, KB, None),
    "/uptime": (cmd_uptime, None, None),
    "/logs": (cmd_logs, None, None),
    "/logfile": (cmd_logfile, None, "file"),
    "/start": (cmd_help, KB, None),
}

def handle_message(text, chat):
    global CHAT_ID
    CHAT_ID = chat
    text = text.strip()

    # check if awaiting settings input
    if chat in conv and conv[chat].get("awaiting"):
        if handle_settings_text(text, chat):
            return

    cmd = text.split()[0].lower()
    item = COMMANDS.get(cmd)
    if item:
        handler, kb, mode = item
        reply = handler(text) if mode == "args" else handler()
        if isinstance(reply, tuple):
            reply, secondary = reply[0], reply[1] if len(reply) > 1 else None
            if mode == "file" and secondary:
                fname = os.path.basename(secondary)
                send_file(secondary, caption=f"\U0001f4dd {fname}", chat=chat)
                send(reply or "\u2705 File sent", chat, keyboard=kb)
                return
            kb = secondary or kb
        if mode == "settings":
            conv[chat] = {"awaiting": "cmd"}
        for i in range(0, len(reply), 4000):
            send(reply[i:i+4000], chat, keyboard=kb)
    else:
        send(f"Unknown: {cmd}\n/help", chat, keyboard=KB)

def poll_loop():
    offset = 0
    while running:
        try:
            resp = tg("getUpdates", {"offset": offset, "timeout": 30})
            if resp.get("ok"):
                for upd in resp.get("result", []):
                    offset = upd["update_id"] + 1
                    msg = upd.get("message", {})
                    if "text" in msg and "chat" in msg:
                        handle_message(msg["text"], msg["chat"]["id"])
            else:
                time.sleep(5)
        except Exception:
            time.sleep(5)

def check_alerts():
    while running:
        if CHAT_ID and settings.get("alerts_enabled"):
            try:
                disk_pct = int(shell("df -h / | tail -1 | awk '{print $5}' | tr -d '%'"))
                if disk_pct >= settings["disk_alert_pct"]:
                    used, total = shell("df -h / | tail -1 | awk '{print $3, $2}'").split()
                    tops = shell("du -sh /* 2>/dev/null | sort -rh | head -5")
                    top_lines = [l for l in tops.split("\n") if l.strip()]
                    top_str = "\n".join(f"\u2523\u2501\u2501 {l.split(chr(9))[1].lstrip('/')}: <code>{l.split(chr(9))[0]}</code>" for l in top_lines)
                    send(f"\u26a0\ufe0f <b>Disk Alert</b>: <code>{used}/{total}</code> ({disk_pct}%)\n\n<b>Top dirs:</b>\n{top_str}")

                mem_pct = int(shell("free | awk '/Mem/ {printf \"%.0f\", $3/$2 * 100}'"))
                if mem_pct >= settings["mem_alert_pct"]:
                    send(f"\u26a0\ufe0f <b>Memory Alert</b>: {mem_pct}% \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u043d\u043e")

                load = float(shell("cat /proc/loadavg | awk '{print $1}'"))
                if load >= settings["cpu_alert_load"]:
                    send(f"\u26a0\ufe0f <b>CPU Alert</b>: load {load} > {settings['cpu_alert_load']}")
            except:
                pass
        for _ in range(60):
            if not running:
                return
            time.sleep(1)

def brief_loop():
    global last_brief_time
    while running:
        now = time.time()
        interval_min = settings.get("brief_interval", 360)
        if CHAT_ID and now - last_brief_time >= interval_min * 60:
            h = interval_min // 60
            m = interval_min % 60
            label = f"{h}h {m}m" if h else f"{m}m"
            now_str = time.strftime("%H:%M %d.%m.%Y", time.localtime(now))
            next_str = time.strftime("%H:%M", time.localtime(now + interval_min * 60))
            send(f"<b>\u23f0 Auto Report</b>  <code>{now_str}</code>\n\u23f1 Next: <code>{next_str}</code> (every {label})\n\n" + cmd_brief())
            last_brief_time = now
        time.sleep(60)

def set_commands():
    tg("setMyCommands", {"commands": [
        {"command": "brief", "description": "Краткая сводка"},
        {"command": "status", "description": "Подробный статус"},
        {"command": "cleanup", "description": "Очистка диска"},
        {"command": "services", "description": "Статус сервисов"},
        {"command": "sites", "description": "Сайты и статус"},
        {"command": "df", "description": "Диски"},
        {"command": "top", "description": "Топ процессов"},
        {"command": "du", "description": "Размер папки сайта"},
        {"command": "settings", "description": "Настройки и алерты"},
        {"command": "uptime", "description": "Аптайм"},
        {"command": "logs", "description": "Последние ошибки"},
        {"command": "logfile", "description": "Файл логов за час"},
        {"command": "help", "description": "Справка"},
    ]})

def main():
    global CHAT_ID
    set_commands()
    resp = tg("getUpdates", {"timeout": 2})
    if resp.get("ok"):
        for upd in resp.get("result", []):
            msg = upd.get("message", {})
            if "chat" in msg:
                CHAT_ID = msg["chat"]["id"]
                break
    threading.Thread(target=poll_loop, daemon=True).start()
    threading.Thread(target=brief_loop, daemon=True).start()
    threading.Thread(target=check_alerts, daemon=True).start()
    print(f"Bot started. CHAT_ID={CHAT_ID}", flush=True)
    while running:
        time.sleep(1)

if __name__ == "__main__":
    main()
