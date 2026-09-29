"""Метрики рефакторинга: строки кода, файлы, дубли, скорость.

Сравнивает baseline (ДО правок, tests/metrics_baseline.json) с ТЕКУЩИМ
состоянием кода. Механика та же, что у живого замера tests/metrics.py.

Требования (см. эпик EPIC_data_delivery_refactor.md):
- app.py: 1170 → < 1170 строк;
- дубль-маркеры движка (_stable_token/_section_token) в app.py: 2 → 0;
- app.py импортирует общий движок (from panel_mediator import);
- медиатор-опрос не медленнее baseline (умеренный запас ×2);
- суммарные строки доставки (14 файлов) не выросли vs baseline.
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import metrics  # noqa: E402

BASELINE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "metrics_baseline.json")


def _load_baseline():
    with open(BASELINE_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


class MetricsAssertions(unittest.TestCase):

    def test_baseline_exists(self):
        self.assertTrue(os.path.exists(BASELINE_PATH),
                        "нет baseline — сначала сними tests/metrics_baseline.json")

    def test_app_py_reduced(self):
        base = _load_baseline()
        live = metrics.lines_of("app.py")
        self.assertIsNotNone(live)
        self.assertLess(live, base["lines"]["app.py"])

    def test_dup_engine_removed(self):
        base = _load_baseline()
        self.assertGreater(base["app_dup_token_markers"], 0)
        self.assertEqual(metrics.count_dup_marker_lines(), 0)

    def test_shared_engine_used(self):
        self.assertTrue(metrics.app_uses_shared_engine())

    def test_mediator_not_slower(self):
        base = _load_baseline()
        if "bench_error" in base:
            self.skipTest("baseline bench недоступна")
        live = metrics.mediator_bench()
        base_median = base["bench"]["median_ms"]
        self.assertLessEqual(live["median_ms"], base_median * 2.0,
                             f"медиатор замедлился: {live['median_ms']}ms > "
                             f"{base_median * 2.0}ms (baseline {base_median}ms)")

    def test_total_delivery_lines_not_grown(self):
        base = _load_baseline()
        live_total = metrics.capture()["total_lines"]
        self.assertLessEqual(live_total, base["total_lines"],
                             f"строк доставки стало больше: {live_total} > "
                             f"{base['total_lines']}")

    def test_delivery_file_count_stable(self):
        base = _load_baseline()
        self.assertEqual(metrics.capture()["files"], base["files"])


if __name__ == "__main__":
    unittest.main(verbosity=2)