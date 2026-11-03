#!/usr/bin/env python3
"""tdiv_invest_daemon.py — совместимость со старыми запусками.

Вся логика — в универсальном `account_invest_daemon.py`; здесь только
подставляется источник «tdiv» (С5 TDIV). Новые счета запускайте напрямую:

    INVEST_SOURCE=trnd python parsers/invest/account_invest_daemon.py
"""
import os
import runpy

os.environ.setdefault("INVEST_SOURCE", "tdiv")

if __name__ == "__main__":
    runpy.run_path(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "account_invest_daemon.py"),
        run_name="__main__",
    )
