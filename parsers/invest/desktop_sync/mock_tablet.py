"""Mock-планшет для проверки десктоп-синхронизации без Android.

Запуск:
  python -m parsers.invest.desktop_sync.mock_tablet --port 9090 --scenario normal

Сценарии:
  normal     — 14 суток истории с шагом 10 минут;
  divergence — одна точка намеренно расходится с десктопом;
  bigbuffer  — histBytes > 200 КБ (проверка prune).
"""
from __future__ import annotations

import argparse
import json
import random
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ACCOUNTS = {
    "finam": 8_600_000.0,
    "funit": 100_900.0,
    "funit2": 1_630_000.0,
    "tdiv": 99_000.0,
    "tinkoff": 57_000.0,
    "trnd": 102_000.0,
}


class State:
    def __init__(self, scenario: str = "normal"):
        self.scenario = scenario
        self.lock = threading.Lock()
        self.points: dict[str, list[list]] = {}
        self.alerts: list[dict] = []
        now = int(time.time() * 1000)
        step = 10 * 60 * 1000
        end = (now // step) * step          # сетка кратна шагу — стабильна между запусками
        start = end - 14 * 86_400_000
        rnd = random.Random(42)
        for src, base in ACCOUNTS.items():
            arr = []
            val = base
            ts = start
            while ts <= end:
                drift = rnd.uniform(-0.0015, 0.0015)
                val = max(1.0, val * (1 + drift))
                arr.append([ts, round(val, 2)])
                ts += step
            self.points[src] = arr
        if scenario == "divergence":
            ts = end - 2 * step
            arr = self.points["finam"]
            for p in arr:
                if p[0] == ts:
                    p[1] = round(p[1] + 1500, 2)
                    break
        if scenario == "bigbuffer":
            self.alerts.append({"ts": now - 60_000, "level": "warn",
                                "text": "mock: история приближается к порогу"})

    def history(self, since: int) -> dict:
        rows = {}
        total = 0
        last = 0
        for src, arr in self.points.items():
            keep = [p for p in arr if p[0] > since]
            if keep:
                rows[src] = keep
            total += len(arr)
            if arr:
                last = max(last, arr[-1][0])
        blob = json.dumps(rows, ensure_ascii=False).encode()
        hist_bytes = len(blob) + (250_000 if self.scenario == "bigbuffer" else 0)
        return {"rows": rows, "last": last, "histPoints": total,
                "histBytes": hist_bytes}

    def prune(self, before: int) -> dict:
        removed = 0
        left = 0
        for src, arr in self.points.items():
            keep = [p for p in arr if p[0] >= before]
            removed += len(arr) - len(keep)
            self.points[src] = keep
            left += len(keep)
        return {"removed": removed, "left": left,
                "histBytes": len(json.dumps(self.points).encode())}


def serve(port: int = 9090, scenario: str = "normal") -> ThreadingHTTPServer:
    state = State(scenario)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _json(self, obj, code=200):
            raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            since = int((q.get("since") or ["0"])[0] or 0)
            if u.path == "/api/ping":
                self._json({"ok": True, "device": "WClock", "version": "mock",
                            "ts": int(time.time() * 1000)})
            elif u.path == "/api/stats":
                h = state.history(0)
                self._json({"ok": True, "device": "WClock", "version": "mock",
                            "ts": int(time.time() * 1000), "mode": "mock",
                            "cpu": 3.2, "rssMb": 120, "histBytes": h["histBytes"],
                            "histPoints": h["histPoints"], "level": 0,
                            "battery": 100, "charging": True,
                            "uptimeSec": 3600, "port": 8080, "lanPort": port})
            elif u.path == "/api/invest/history":
                self._json(state.history(since))
            elif u.path == "/api/alerts":
                self._json({"alerts": [a for a in state.alerts if a["ts"] > since],
                            "total": len(state.alerts)})
            elif u.path == "/api/data":
                self._json({"mode": "mock", "resources": {"cpu": 3.2, "rssMb": 120,
                                                          "histKb": 200, "histPoints": 100,
                                                          "level": 0}})
            else:
                self._json({"error": "not found"}, 404)

        def do_POST(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            if u.path == "/api/invest/prune":
                before = int((q.get("before") or ["0"])[0] or 0)
                if before <= 0:
                    self._json({"error": "before required"}, 400)
                else:
                    self._json(state.prune(before))
            else:
                self._json({"error": "not found"}, 404)

    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    return srv


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9090)
    ap.add_argument("--scenario", default="normal",
                    choices=["normal", "divergence", "bigbuffer"])
    a = ap.parse_args()
    srv = serve(a.port, a.scenario)
    print(f"mock tablet on :{a.port} ({a.scenario}) — Ctrl+C")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        srv.shutdown()
