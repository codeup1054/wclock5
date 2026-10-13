#!/usr/bin/env python3
import json, urllib.request
req = urllib.request.Request(
    "http://localhost:10405/api/data_mediator",
    data=json.dumps({"v": {}}).encode("utf-8"),
    headers={"Content-Type": "application/json"}, method="POST")
with urllib.request.urlopen(req, timeout=30) as r:
    d = json.loads(r.read().decode("utf-8"))
t = d["changed"].get("invest.turnover", {})
print("invest.turnover ->", json.dumps(t, ensure_ascii=False, indent=1))
print("day rows used (app reads today=18.09): finam total =", t.get("finam", {}).get("total"))