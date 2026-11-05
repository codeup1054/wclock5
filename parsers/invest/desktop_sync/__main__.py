"""CLI: python -m parsers.invest.desktop_sync [--once] [--mock]."""
from __future__ import annotations

import argparse
import json

from .config import load_config
from .sync import SyncRunner


def main() -> int:
    ap = argparse.ArgumentParser(description="WClock: синхронизация с планшетом")
    ap.add_argument("--once", action="store_true", help="один проход без UI")
    ap.add_argument("--yes", action="store_true", help="prune без подтверждения")
    ap.add_argument("--host", help="override host планшета")
    ap.add_argument("--port", type=int, help="override LAN-порт")
    ap.add_argument("--mock", nargs="?", const="normal",
                    choices=["normal", "divergence", "bigbuffer"],
                    help="поднять mock-планшет на 127.0.0.1:<port>")
    args = ap.parse_args()

    cfg = load_config()
    if args.host:
        cfg["host"] = args.host
    if args.port:
        cfg["port"] = args.port

    if args.mock:
        from .mock_tablet import serve
        port = args.port or 9090
        serve(port, args.mock)
        cfg["host"] = "127.0.0.1"
        cfg["port"] = port

    if args.once or args.mock:
        runner = SyncRunner(cfg, confirm_prune=(lambda *_: True) if args.yes else None)
        try:
            rep = runner.run()
        finally:
            runner.close()
        print(json.dumps(rep, ensure_ascii=False, indent=2))
        return 0 if rep.get("ok") else 1

    from .ui import run_ui
    run_ui()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
