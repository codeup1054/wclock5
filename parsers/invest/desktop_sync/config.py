"""Конфигурация десктоп-синхронизации WClock.

config.json лежит рядом с пакетом и в git не попадает (там токен Telegram).
Пути в конфиге можно задавать относительно каталога пакета.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

PKG_DIR = Path(__file__).resolve().parent
INVEST_DIR = PKG_DIR.parent
PROJECT_ROOT = PKG_DIR.parents[2]
CONFIG_PATH = PKG_DIR / "config.json"

DEFAULTS = {
    # планшет
    "host": "192.168.3.33",
    "port": 9090,
    "timeoutSec": 5,
    "retries": 3,
    # автосинк
    "autoStart": True,
    "syncMinutes": 10,          # при отладке 10, в норме можно 60
    "syncMinutesNormal": 60,
    "fullSyncHours": 24,   # раз в сутки сверять всё (ловит расхождения в старых точках)
    # хранение
    "archiveDir": "data",
    "hotDbPath": str(INVEST_DIR / "invest_portfolio.db"),
    "maxTabletKb": 200,
    "maxArchiveMb": 500,
    "sqliteVacuumMb": 1024,
    # очистка планшета
    "pruneAfterSync": True,
    "askBeforePrune": True,
    "keepDaysOnTablet": 7,
    # алерты
    "logsDir": "logs",
    "alertRetentionDays": 90,
    "telegramEnabled": True,
    "telegramToken": "",
    "telegramChatId": "",
    "telegramProxy": "",
    "telegramLevels": ["warn", "alert"],
    "telegramPrefixDesktop": "[SK_DESK]",
    "telegramPrefixTablet": "[TAB]",
    # проверки
    "clockSkewSec": 60,
    "gapFactor": 2,
    "resourceWarnCpu": 60,
    "resourceAlertCpu": 80,
    "resourceWarnRssMb": 180,
    "resourceAlertRssMb": 240,
    "bufferWarnKb": 200,
    "bufferAlertKb": 400,
}


def _resolve(value: str) -> str:
    p = Path(value)
    return str(p if p.is_absolute() else (PKG_DIR / p))


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except Exception:
            pass
    # .env проекта (TELEGRAM_*) — без сторонних зависимостей
    env = _read_env(PROJECT_ROOT / ".env")
    if env.get("TELEGRAM_BOT_TOKEN"):
        cfg["telegramToken"] = env["TELEGRAM_BOT_TOKEN"]
    if env.get("TELEGRAM_CHAT_ID"):
        cfg["telegramChatId"] = env["TELEGRAM_CHAT_ID"]
    if env.get("TELEGRAM_PROXY"):
        cfg["telegramProxy"] = env["TELEGRAM_PROXY"]
    cfg["archiveDir"] = _resolve(cfg["archiveDir"])
    cfg["logsDir"] = _resolve(cfg["logsDir"])
    return cfg


def save_config(cfg: dict) -> None:
    data = dict(cfg)
    # обратно в относительные пути, чтобы конфиг переносился
    for key in ("archiveDir", "logsDir"):
        try:
            data[key] = str(Path(data[key]).resolve().relative_to(PKG_DIR)).replace("\\", "/")
        except Exception:
            pass
    CONFIG_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _read_env(path: Path) -> dict:
    out = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    except Exception:
        pass
    return out
