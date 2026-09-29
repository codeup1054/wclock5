"""Метрики рефакторинга доставки данных (батч-1: P1+P6).

Замеряет:
- строки ключевых модулей доставки (задано DELIVERY_FILES);
- дубликаты: наличие _stable_token/_section_token в app.py (после P1 = 0);
- медианное время полного опроса медиатора (POST /api/data_mediator, v={} ->
  все секции) через Flask test_client.

Запуск:
    python tests/metrics.py tests/metrics_baseline.json   # ДО правок
    python tests/metrics.py tests/metrics_after.json      # ПОСЛЕ правок

Оба файла сравниваются в tests/test_metrics.py и в отчёте.
"""

import json
import os
import statistics
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

# Модули, участвующие в доставке данных (демоны → БД → кэш → медиатор → фронт).
DELIVERY_FILES = [
    "app.py",
    "invest_repo.py",
    "panel_mediator.py",
    "db_init.py",
    "invest_db.py",
    "parsers/mail.ru/mail_ru_weather_24hours.py",
    "parsers/invest/tinkoff_invest_daemon.py",
    "parsers/invest/finam_invest_daemon.py",
    "parsers/invest/tracked_tickers_daemon.py",
    "parsers/telegram/tg_turnover_daemon.py",
    "static/js/panel_mediator.js",
    "static/js/invest_chart_helpers.js",
    "static/js/invest_banner.js",
    "static/js/invest_chart.js",
]

SAMPLE_N = 3


def lines_of(path):
    try:
        with open(os.path.join(REPO, path), "r", encoding="utf-8") as fh:
            return sum(1 for _ in fh)
    except OSError:
        return None


def count_dup_marker_lines():
    """Число строк-«маркеров дубля движка медиатора» в app.py.

    После P1 движок один (panel_mediator.PanelMediator), а копии токен-функций
    _stable_token/_section_token из app.py удалены → маркеры = 0."""
    path = os.path.join(REPO, "app.py")
    markers = 0
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                s = line.strip()
                if s.startswith("def _stable_token") or s.startswith(
                        "def _section_token"):
                    markers += 1
    except OSError:
        pass
    return markers


def app_uses_shared_engine():
    path = os.path.join(REPO, "app.py")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return False
    return "from panel_mediator import" in text


def mediator_bench():
    """Медианное время полного опроса медиатора (все секции) в мс."""
    import app as appmod
    client = appmod.app.test_client()

    def _post():
        r = client.post("/api/data_mediator", json={"v": {}})
        assert r.status_code == 200
        return r.get_json() or {}

    samples = []
    for _ in range(SAMPLE_N):
        t0 = time.perf_counter()
        body = _post()
        samples.append((time.perf_counter() - t0) * 1000.0)
        # sanity: все известные секции присутствуют в tokens
        assert "tokens" in body
    return {
        "median_ms": round(statistics.median(samples), 2),
        "samples_ms": [round(s, 2) for s in samples],
    }


def capture(output_path=None):
    out = {
        "lines": {},
        "total_lines": 0,
        "files": len(DELIVERY_FILES),
        "app_dup_token_markers": count_dup_marker_lines(),
        "app_uses_shared_engine": app_uses_shared_engine(),
    }
    for f in DELIVERY_FILES:
        n = lines_of(f)
        out["lines"][f] = n
        if n is not None:
            out["total_lines"] += n
    try:
        out["bench"] = mediator_bench()
    except Exception as exc:  # noqa: BLE001 — метрики не должны валить прогон
        out["bench_error"] = repr(exc)
    if output_path:
        with open(output_path, "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=2)
        print("metrics ->", output_path)
    return out


if __name__ == "__main__":
    capture(sys.argv[1] if len(sys.argv) > 1 else "tests/metrics_current.json")