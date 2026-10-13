#!/usr/bin/env python3
# Smoke: медиатор /api/data_mediator (Mn-31). Запуск на проде: python3 /tmp/smoke_mediator_prod.py
import json
import urllib.request

BASE = "http://localhost:10405/api/data_mediator"


def post(payload):
    req = urllib.request.Request(
        BASE,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


expected = sorted([
    "battery.history", "charts_data", "settings", "weather",
    "invest.history", "invest.tickers", "invest.turnover",
])

ok = True

# [1] пустой v -> все секции (полный набор)
d1 = post({"v": {}})
sects = sorted(d1["changed"].keys())
good = sects == expected
ok &= good
print(("[OK]  " if good else "[FAIL]") + " empty-v -> sections == " + repr(sects))

# [1b] invest-секции без _error
for s in ("invest.history", "invest.tickers", "invest.turnover"):
    v = d1["changed"].get(s)
    bad = isinstance(v, dict) and "_error" in v
    ok &= not bad
    print(("[OK]  " if not bad else "[FAIL]") + f" {s} payload ok")

# [2] повтор с теми же токенами -> дельта пуста
d2 = post({"v": d1["tokens"]})
good = d2["changed"] == {}
ok &= good
print(("[OK]  " if good else "[FAIL]") + " repeat -> delta empty" +
      ("" if good else " (non-empty: " + repr(list(d2["changed"].keys())) + ")"))

# [3] write батареи
d3 = post({"write": {"battery": {"device_id": "smoke_prod_001", "value": 88}}})
w = d3["writes"]["battery"]
good = w.get("applied") is True or w.get("skipped") is True
ok &= good
print(("[OK]  " if good else "[FAIL]") + " write battery -> " + json.dumps(w, ensure_ascii=False))

# [4] раздельная дельта: старый/новый токен батареи
t0 = d1["tokens"]["battery.history"]
d4 = post({"v": {"battery.history": t0}, "params": {"battery.history": {"device_id": "smoke_prod_001"}}})
good = "battery.history" in d4["changed"]
ok &= good
print(("[OK]  " if good else "[FAIL]") + " old-token read -> battery.history in delta")

print("----")
print("ALL_PASS" if ok else "HAS_FAIL")