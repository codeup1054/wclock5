"""HTTP-клиент планшета: ping/stats/history/prune/alerts.

Только стандартная библиотека, таймауты 5 с и 3 ретрая с backoff.
"""
from __future__ import annotations

import json
import socket
import time
import urllib.error
import urllib.parse
import urllib.request


class TabletError(Exception):
    pass


class TabletUnavailable(TabletError):
    pass


class TabletBadResponse(TabletError):
    pass


class TabletClient:
    def __init__(self, host: str, port: int, timeout: float = 5.0, retries: int = 3):
        self.host = host
        self.port = int(port)
        self.timeout = float(timeout)
        self.retries = max(1, int(retries))

    @property
    def base(self) -> str:
        return f"http://{self.host}:{self.port}"

    def _request(self, path: str, params: dict | None = None,
                 method: str = "GET", body: bytes | None = None) -> dict:
        query = ""
        if params:
            query = "?" + urllib.parse.urlencode({k: v for k, v in params.items()
                                                  if v is not None})
        url = self.base + path + query
        last_err = None
        for attempt in range(self.retries):
            try:
                req = urllib.request.Request(url, data=body, method=method)
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    raw = resp.read()
                try:
                    data = json.loads(raw.decode("utf-8"))
                except Exception as e:
                    raise TabletBadResponse(f"не JSON: {e}")
                if not isinstance(data, dict):
                    raise TabletBadResponse("ожидался JSON-объект")
                return data
            except urllib.error.HTTPError as e:
                if e.code >= 500 and attempt + 1 < self.retries:
                    last_err = f"HTTP {e.code}"
                else:
                    raise TabletBadResponse(f"HTTP {e.code} {path}")
            except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as e:
                last_err = str(getattr(e, "reason", e))
            if attempt + 1 < self.retries:
                time.sleep(0.5 * (2 ** attempt))
        raise TabletUnavailable(f"{self.host}:{self.port} недоступен ({last_err})")

    def ping(self) -> dict:
        d = self._request("/api/ping")
        if not d.get("ok"):
            raise TabletBadResponse("ping: ok != true")
        return d

    def stats(self) -> dict:
        return self._request("/api/stats")

    def history(self, since_ms: int = 0) -> dict:
        d = self._request("/api/invest/history", {"since": int(since_ms)})
        rows = d.get("rows")
        if rows is None:
            raise TabletBadResponse("history: нет поля rows")
        if not isinstance(rows, dict):
            raise TabletBadResponse("history: rows не объект")
        return d

    def prune(self, before_ms: int) -> dict:
        return self._request("/api/invest/prune", {"before": int(before_ms)}, method="POST")

    def alerts(self, since_ms: int = 0) -> dict:
        d = self._request("/api/alerts", {"since": int(since_ms)})
        if not isinstance(d.get("alerts", []), list):
            raise TabletBadResponse("alerts: не список")
        return d
