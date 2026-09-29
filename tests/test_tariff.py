"""P2: детали тарифа («Тариф процентный») из каналов брокера.

Демон один раз при приходе сообщения парсит и кладёт JSON в
tariff_details (day, source). Здесь поверяется parse_tariff на текстах
реального формата каналов (✅ Тариф процентный… / Комиссия … при базе …
(сессия … + вечер прошлого дня …) и N исполненных поручениях / Ставка
X% с оборота, Y₽ на поручение) и upsert-семантика save_tariff + бэкфилл.
"""

import hashlib
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_dbfd, _dbpath = tempfile.mkstemp(suffix=".db")
os.close(_dbfd)
os.environ["TG_TURNOVER_DB"] = _dbpath

from parsers.telegram import tg_turnover_daemon as daemon  # noqa: E402

FINAM_CHAT = "Сделки Бота — ПРОД Сергей Финам (TGLD)"
TINKOFF_CHAT = "Сделки Бота — ПРОД Сергей Т-Инвест (TGLD)"

FINAM_TEXT = (
    "✅ Тариф процентный, минималки нет.\n"
    "ТС-1 за 2026-09-27 / Комиссия 48 969 ₽ при базе 2 447 723 ₽ "
    "(сессия 1 843 + вечер прошлого дня 2 445 880) и 142 исполненных "
    "поручениях\nСтавка 2% с оборота, 25₽ на поручение"
)
TINKOFF_TEXT = (
    "✅ Тариф процентный, минималки нет.\n"
    "ТС-2 за 2026-09-27 / Комиссия 12 304 ₽ при базе 615 200 ₽ "
    "(сессия 1 845 + вечер прошлого дня 613 355) и 91 исполненных "
    "поручениях\nСтавка 2% с оборота, 25₽ на поручение"
)


class TariffParseTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        daemon.init_db()

    def test_parse_finam(self):
        p = daemon.parse_tariff(FINAM_TEXT, FINAM_CHAT)
        self.assertIsNotNone(p)
        self.assertEqual(p["day"], "2026-09-27")
        self.assertEqual(p["source"], "finam")
        self.assertEqual(p["commission"], 48969.0)
        self.assertEqual(p["base"], 2447723.0)
        self.assertEqual(p["session"], 1843.0)
        self.assertEqual(p["evening"], 2445880.0)
        self.assertEqual(p["orders"], 142)
        self.assertEqual(p["rate_percent"], 2.0)
        self.assertEqual(p["fee_per_order"], 25.0)

    def test_parse_tinkoff(self):
        p = daemon.parse_tariff(TINKOFF_TEXT, TINKOFF_CHAT)
        self.assertIsNotNone(p)
        self.assertEqual(p["day"], "2026-09-27")
        self.assertEqual(p["source"], "tinkoff")
        self.assertEqual(p["commission"], 12304.0)
        self.assertEqual(p["orders"], 91)

    def test_parse_non_tariff(self):
        self.assertIsNone(daemon.parse_tariff(
            "💸 Оборот 1 234 567 ₽, капитал 2 345 ₽ за 2026-09-27",
            FINAM_CHAT))

    def test_parse_no_date(self):
        self.assertIsNone(daemon.parse_tariff(
            "Тариф процентный, минималки нет. Ставка 2% с оборота",
            FINAM_CHAT))

    def test_tariff_source_unknown_chat(self):
        self.assertIsNone(daemon.parse_tariff(FINAM_TEXT, "Какой-то чат"))

    def test_save_tariff_insert_and_edit(self):
        text = FINAM_TEXT.replace("2026-09-27", "2026-09-28")
        con = daemon._conn()
        con.execute("DELETE FROM tariff_details WHERE day='2026-09-28'")
        con.commit(); con.close()
        daemon.save_tariff(FINAM_CHAT, 1001, 1790660000, text)
        daemon.save_tariff(FINAM_CHAT, 1001, 1790660000, text)
        con = daemon._conn()
        rows = con.execute(
            "SELECT count(*), payload_json FROM tariff_details"
            " WHERE day='2026-09-28'").fetchone()
        self.assertEqual(rows[0], 1, "повтор той же правки не должен дублировать")
        edited = text.replace("48 969", "50 100")
        daemon.save_tariff(FINAM_CHAT, 1001, 1790660100, edited)
        con2 = daemon._conn()
        rows2 = con2.execute(
            "SELECT count(*), payload_json FROM tariff_details"
            " WHERE day='2026-09-28'").fetchone()
        self.assertEqual(rows2[0], 1)
        payload = json.loads(rows2[1])
        self.assertEqual(payload["commission"], 50100.0)
        con.close(); con2.close()

    def test_save_tariff_skips_non_tariff(self):
        con = daemon._conn()
        before = con.execute("SELECT count(*) FROM tariff_details").fetchone()[0]
        daemon.save_tariff(FINAM_CHAT, 2002, 1790660000,
                           "💸 Оборот 1 234 567 ₽ за 2026-09-29")
        after = con.execute("SELECT count(*) FROM tariff_details").fetchone()[0]
        self.assertEqual(before, after)
        con.close()

    def test_backfill_tariff_from_bot_events(self):
        con = daemon._conn()
        con.execute("DELETE FROM tariff_details WHERE day='2026-09-29'")
        con.execute("DELETE FROM bot_events WHERE msg_id IN (3001, 3002)")
        con.execute(
            "INSERT INTO bot_events (msg_id, chat, ts_epoch, update_type, text, raw)"
            " VALUES (3001, ?, 1790660000, 'channel_post', ?, ?)",
            (TINKOFF_CHAT, TINKOFF_TEXT.replace("2026-09-27", "2026-09-29"),
             TINKOFF_TEXT.replace("2026-09-27", "2026-09-29")[:800]))
        con.commit(); con.close()
        n = daemon.backfill_tariff(limit=10)
        con = daemon._conn()
        rows = con.execute(
            "SELECT payload_json FROM tariff_details"
            " WHERE day='2026-09-29' AND source='tinkoff'").fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(json.loads(rows[0][0])["day"], "2026-09-29")
        con.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)