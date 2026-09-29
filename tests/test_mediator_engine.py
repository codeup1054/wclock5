"""Юнит-тесты единого движка медиатора (panel_mediator.PanelMediator).

Без импорта app.py — чистый движок + хуки, которые использует подкласс
_WClockMediator (tail-логика invest.history).
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from panel_mediator import PanelMediator, stable_token  # noqa: E402


class _Factory:
    """Читатели-заготовки: reader возвращает фиксированный payload, запоминая params."""

    def __init__(self):
        self.calls = {}

    def reader(self, sect, payload):
        def _r(p):
            self.calls[sect] = p
            return payload
        return _r


class TestStableToken(unittest.TestCase):
    def test_idempotent(self):
        p = {"a": 1, "b": [1, 2], "c": None}
        self.assertEqual(stable_token(p), stable_token(p))

    def test_order_insensitive(self):
        self.assertEqual(stable_token({"a": 1, "b": 2}),
                         stable_token({"b": 2, "a": 1}))

    def test_different_payload(self):
        self.assertNotEqual(stable_token({"a": 1}), stable_token({"a": 2}))

    def test_none(self):
        self.assertEqual(stable_token(None), stable_token({}))


class TestDelta(unittest.TestCase):
    def setUp(self):
        self.f = _Factory()
        self.m = PanelMediator(readers={
            "widget": self.f.reader("widget", {"value": 42}),
        })

    def test_unchanged_token_not_delivered(self):
        tokens = self.m.read({"widget": ""})[1]
        changed, _ = self.m.read({"widget": tokens["widget"]})
        self.assertNotIn("widget", changed)

    def test_unknown_token_full_delivery(self):
        changed, tokens = self.m.read({"widget": ""})
        self.assertIn("widget", changed)
        self.assertEqual(changed["widget"], {"value": 42})
        self.assertTrue(tokens["widget"])

    def test_unknown_section_error(self):
        changed, tokens = self.m.read({"bogus": ""})
        self.assertIn("bogus", changed)
        self.assertIn("_error", changed["bogus"])
        self.assertIn("bogus", tokens)

    def test_params_passed_to_reader(self):
        self.m.read({"widget": ""}, params={"widget": {"k": "v"}})
        self.assertEqual(self.f.calls["widget"], {"k": "v"})


class TestHooks(unittest.TestCase):
    """Хуки WClock: tail-логика invest.history."""

    def setUp(self):
        self.f = _Factory()

        class _W(PanelMediator):
            def prepare_params(self, sect, client_tok, params, ctx):
                params = dict(params or {})
                if sect == "invest.history":
                    after = params.get("after_ts")
                    if after is None and client_tok \
                            and str(client_tok).isdigit() and int(client_tok) > 0:
                        after = int(client_tok)
                    if after is not None:
                        params["after_ts"] = after
                        ctx["tail"] = True
                return params

            def post_read(self, sect, payload, ctx):
                if ctx.get("tail") and isinstance(payload, dict) \
                        and not payload.get("_error"):
                    payload["_tail"] = True
                return payload

            def section_token(self, sect, payload):
                if sect == "invest.history" and isinstance(payload, dict) \
                        and payload.get("_latest_epoch") is not None:
                    return str(payload["_latest_epoch"])
                return stable_token(payload)

        self.W = _W

    def _history(self, epoch_seen):
        hist = {"2026-09-29T08:00:00+00:00": 100, "_latest_epoch": epoch_seen,
                "_count": 1}
        return self.W(readers={"invest.history": self.f.reader("invest.history", hist)})

    def test_history_token_is_epoch(self):
        m = self._history(1500000)
        _, tokens = m.read({"invest.history": ""})
        self.assertEqual(tokens["invest.history"], "1500000")
        self.assertNotEqual(tokens["invest.history"], stable_token({}))

    def test_digit_token_injects_after_ts_tail(self):
        m = self._history(1500000)
        changed, _ = m.read({"invest.history": "1400000"})
        self.assertEqual(self.f.calls["invest.history"]["after_ts"], 1400000)
        self.assertTrue(changed["invest.history"].get("_tail"))

    def test_explicit_after_ts_preferred(self):
        m = self._history(1500000)
        params = {"invest.history": {"after_ts": 777}}
        m.read({"invest.history": ""}, params=params)
        self.assertEqual(self.f.calls["invest.history"]["after_ts"], 777)

    def test_full_load_no_tail(self):
        m = self._history(1500000)
        changed, _ = m.read({"invest.history": ""})
        self.assertFalse(changed["invest.history"].get("_tail"))

    def test_error_payload_not_marked_tail(self):
        class _Err(PanelMediator):
            def prepare_params(self, sect, client_tok, params, ctx):
                ctx["tail"] = True
                return params

            def post_read(self, sect, payload, ctx):
                if ctx.get("tail") and isinstance(payload, dict) \
                        and not payload.get("_error"):
                    payload["_tail"] = True
                return payload

        m = _Err(readers={"s": lambda p: {"_error": "boom"}})
        changed, _ = m.read({"s": ""})
        self.assertIn("_error", changed["s"])
        self.assertNotIn("_tail", changed["s"])


class TestWrite(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.m = PanelMediator(
            writers={"bat": lambda p: self._write(p)},
            write_interval={"bat": 60},
        )

    def _write(self, p):
        self.calls.append(p)
        if p.get("bad"):
            return {"_error": "value out of range"}
        return {"ok": True}

    def test_applied(self):
        writes = self.m.write({"bat": {"value": 50}})
        self.assertTrue(writes["bat"]["applied"])

    def test_unchanged_within_interval_skipped(self):
        self.m.write({"bat": {"value": 50}})
        writes = self.m.write({"bat": {"value": 50}})
        self.assertFalse(writes["bat"]["applied"])
        self.assertTrue(writes["bat"]["skipped"])

    def test_changed_value_applied_even_in_interval(self):
        self.m.write({"bat": {"value": 50}})
        writes = self.m.write({"bat": {"value": 51}})
        self.assertTrue(writes["bat"]["applied"])

    def test_error_contract(self):
        writes = self.m.write({"bat": {"value": 1, "bad": True}})
        self.assertFalse(writes["bat"]["applied"])
        self.assertIn("reason", writes["bat"])

    def test_no_writer(self):
        writes = self.m.write({"nope": {"value": 1}})
        self.assertTrue(writes["nope"]["skipped"])


class TestProcessShape(unittest.TestCase):
    def test_process_keys(self):
        m = PanelMediator(readers={"s": lambda p: {"x": 1}})
        res = m.process({"v": {"s": ""}})
        self.assertEqual({"changed", "tokens", "ts", "writes"}, set(res.keys()))
        self.assertIn("s", res["changed"])
        self.assertIn("s", res["tokens"])

    def test_process_accepts_params_key(self):
        seen = {}

        def reader(p):
            seen.update(p)
            return {"x": 1}

        m = PanelMediator(readers={"s": reader})
        m.process({"v": {"s": ""}, "params": {"s": {"after_ts": 5}}})
        self.assertEqual(seen.get("after_ts"), 5)


if __name__ == "__main__":
    unittest.main(verbosity=2)