# -*- coding: utf-8 -*-
"""Финишная проверка цикла записи->дельты через медиатор (ит.1+2).
Запуск: python e2e_mediator_final.py  (из каталога wclock5, без сервера/curl)."""
import json
import time
import app as m

DEVICE = "e2e_final_" + str(int(time.time()))
c = m.app.test_client()

EXPECTED = sorted([
    "battery.history", "charts_data", "settings", "weather",
    "invest.history", "invest.tickers", "invest.turnover",
])

ok = []

# [1] clean state: пустой v -> все секции
r = c.post("/api/data_mediator", json={"v": {}, "params": {"battery.history": {"device_id": DEVICE}}})
assert r.status_code == 200, r.status_code
d = r.get_json()
sects = sorted(d["changed"].keys())
ok.append(("A empty-v -> changed", sects == EXPECTED))
t0 = d["tokens"]["battery.history"]

# [1b] invest.sekции несут данные (не _error)
for s in ("invest.history", "invest.tickers", "invest.turnover"):
    v = d["changed"].get(s)
    bad = isinstance(v, dict) and "_error" in v
    ok.append((f"A.{s} payload ok", not bad))

# [2] повтор с теми же -> дельта пуста
r2 = c.post("/api/data_mediator", json={"v": d["tokens"], "params": {"battery.history": {"device_id": DEVICE}}})
d2 = r2.get_json()
ok.append(("B repeat -> delta empty", d2["changed"] == {} and d2["tokens"]["battery.history"] == t0))

# [3] запись батареи через медиатор (write-key)
r3 = c.post("/api/data_mediator", json={"write": {"battery": {"device_id": DEVICE, "value": 91}}})
d3 = r3.get_json()
w = d3["writes"]["battery"]
ok.append(("C write battery applied", w["applied"] is True or w.get("skipped") is True))

# [4] СТАРЫЙ токен + write: battery.history обязан попасть в changed (значение изменилось)
r4 = c.post("/api/data_mediator", json={"v": {"battery.history": t0}, "params": {"battery.history": {"device_id": DEVICE}}})
d4 = r4.get_json()
in_changed = "battery.history" in d4["changed"]
ok.append(("D old-token read -> battery.history in delta", in_changed))
new_tok = d4["tokens"].get("battery.history")

# [5] новый токен -> дельта пуста (замкнули цикл)
r5 = c.post("/api/data_mediator", json={"v": {"battery.history": new_tok}, "params": {"battery.history": {"device_id": DEVICE}}})
d5 = r5.get_json()
ok.append(("E new-token read -> delta empty", d5["changed"] == {}))

for name, passed in ok:
    print(("  [OK]  " if passed else "  [FAIL]") + name)
print("----")
print("ALL_PASS" if all(p for _, p in ok) else "HAS_FAIL")
