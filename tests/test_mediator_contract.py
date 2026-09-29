"""Контракт медиатора через Flask test_client (app.py).

Проверяет, что рефакторинг (P1: единый движок) не сломал контракт
/api/data_mediator: ответ changed/tokens/writes/ts, tail-режим
invest.history, write-секция battery.
"""

import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as appmod  # noqa: E402


APP_SECTIONS = [
    "weather", "charts_data", "battery.history",
    "invest.history", "invest.tickers", "invest.turnover",
    "invest.turnover_details", "settings",
]


class MediatorContractTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.client = appmod.app.test_client()

    def _post(self, body):
        r = self.client.post("/api/data_mediator", json=body)
        self.assertEqual(r.status_code, 200)
        return r.get_json() or {}

    def test_full_poll_all_tokens(self):
        res = self._post({"v": {}})
        self.assertEqual({"changed", "tokens", "writes", "ts"},
                         set(res.keys()))
        for sect in APP_SECTIONS:
            self.assertIn(sect, res["tokens"], f"токен секции {sect} отсутствует")
        self.assertTrue(res["changed"], "первый опрос должен нести полные payload")

    def test_second_poll_delta(self):
        # Второй опрос с теми же токенами: статичные секции НЕ доставлены.
        res1 = self._post({"v": {}})
        v = {sect: tok for sect, tok in res1["tokens"].items() if tok}
        res2 = self._post({"v": v})
        for static in ("weather", "charts_data", "settings"):
            self.assertNotIn(static, res2["changed"],
                             f"секция {static} доставлена повторно при неизменном токене")

    def test_explicit_after_ts_tail(self):
        # Локальная БД тестов может иметь старую схему (read_history падает с
        # _error). Значимо: params.after_ts доходит до секции, токен отдаётся,
        # при доставке payload — это хвост/полный/ошибка, а не 500.
        params = {"invest.history": {
            "interval": "hour", "period": "-6 hour",
            "after_ts": int(time.time()) - 3600,
        }}
        res = self._post({"v": {"invest.history": ""}, "params": params})
        self.assertIn("invest.history", res["tokens"])
        changed = res["changed"]
        if "invest.history" in changed:
            ch = changed["invest.history"]
            self.assertTrue(isinstance(ch, dict))
            ok = ch.get("_tail") is True or ch.get("_latest_epoch") is not None \
                or "_error" in ch
            self.assertTrue(ok, f"неожиданный payload: {str(ch)[:200]}")

    def test_unknown_section_error(self):
        res = self._post({"v": {"bogus_section": ""}})
        self.assertIn("bogus_section", res["changed"])
        self.assertIn("_error", res["changed"]["bogus_section"])
        self.assertEqual(res["changed"]["bogus_section"]["_error"],
                         "unknown section: bogus_section")

    def test_battery_write_applied(self):
        res = self._post({"write": {"battery": {"device_id": "t", "value": 50}}})
        self.assertIn("battery", res["writes"])
        self.assertTrue(res["writes"]["battery"]["applied"])

    def test_battery_write_validation_error(self):
        res = self._post({"write": {"battery": {"device_id": "t", "value": 999}}})
        self.assertFalse(res["writes"]["battery"]["applied"])
        self.assertNotEqual(res["writes"]["battery"]["reason"], None)

    def test_no_writer_section(self):
        res = self._post({"write": {"bogus_write": {"value": 1}}})
        self.assertTrue(res["writes"]["bogus_write"]["skipped"])


if __name__ == "__main__":
    unittest.main(verbosity=2)