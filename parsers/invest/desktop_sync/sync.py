"""Один проход синхронизации планшет → десктоп.

Порядок: ping → stats → history(since) → архив → горячая БД → проверка →
prune (с подтверждением) → алерты → CSV-отчёт.
"""
from __future__ import annotations

import csv
import time
from pathlib import Path

from .alerts import AlertManager
from .api_client import TabletBadResponse, TabletClient, TabletUnavailable
from .archive import open_archive
from .hotdb import HotDB


class SyncRunner:
    def __init__(self, cfg: dict, confirm_prune=None, log=None):
        self.cfg = cfg
        self.confirm_prune = confirm_prune
        self.log = log or (lambda msg: None)
        self.archive = open_archive(cfg)
        self.alerts = AlertManager(cfg["logsDir"], cfg)
        self.state_path = Path(cfg["logsDir"]) / "sync_state.json"
        self.state = self._load_state()
        self.hot = None

    def close(self) -> None:
        self.alerts.close()
        if self.hot is not None:
            self.hot.close()
            self.hot = None

    # ------------------------------------------------------------- state
    def _load_state(self) -> dict:
        import json
        try:
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        except Exception:
            return {"last_full_sync": 0, "tablet_alerts_ts": 0}

    def _save_state(self) -> None:
        import json
        try:
            self.state_path.write_text(json.dumps(self.state, ensure_ascii=False, indent=1),
                                       encoding="utf-8")
        except Exception:
            pass

    # --------------------------------------------------------------- run
    def run(self) -> dict:
        started = time.time()
        now_ms = int(started * 1000)
        rep = {
            "ok": False, "started": now_ms, "duration": 0.0,
            "tablet": {}, "since": 0, "new_points": 0,
            "archive_added": 0, "hot_added": 0, "hot_buckets": 0,
            "sources": {}, "tablet_last": 0, "removed": 0, "left": 0,
            "archive_bytes": self.archive.size_bytes(),
            "archive_total": self.archive.count(),
            "diverged": 0, "error": "",
        }
        client = TabletClient(self.cfg["host"], self.cfg["port"],
                              self.cfg.get("timeoutSec", 5),
                              self.cfg.get("retries", 3))
        try:
            ping = client.ping()
            rep["tablet"] = ping
            stats = client.stats()
            rep["tablet"].update(stats)
            self._check_tablet(now_ms, ping, stats)

            since = self._since()
            rep["since"] = since
            if since == 0:
                self.state["last_full_sync"] = now_ms
            hist = client.history(since)
            rep["tablet_last"] = int(hist.get("last") or 0)
            hist_bytes = int(hist.get("histBytes") or stats.get("histBytes") or 0)
            rep["tablet"]["histBytes"] = hist_bytes

            points = self._flatten(hist.get("rows") or {}, since)
            rep["new_points"] = len(points)
            self._sources_report(rep, points)

            added = self.archive.add(points)
            rep["archive_added"] = int(added.get("added", 0))
            diverged = list(added.get("diverged", []))

            self.hot = HotDB(self.cfg["hotDbPath"])
            hot_points = [p for p in points if p["source"] != "total"]
            merged = self.hot.merge(hot_points, now_ms)
            rep["hot_added"] = merged["added_history"]
            rep["hot_buckets"] = merged["added_buckets"]
            diverged.extend(merged.get("diverged", []))
            # Последняя точка обновляется на планшете при каждом опросе —
            # её изменение не расхождение, а свежее значение.
            latest = int(rep.get("tablet_last") or 0)
            if latest:
                diverged = [d for d in diverged if int(d.get("ts") or 0) != latest]
            rep["diverged"] = len(diverged)
            if diverged:
                self._divergence_alert(diverged)

            self._check_gap(now_ms, rep, points)
            self._save_state()
            self._maybe_prune(client, rep, hist_bytes, now_ms)
            self._pull_tablet_alerts(client)
            self._check_archive_sizes(rep)

            rep["ok"] = True
        except TabletUnavailable as e:
            rep["error"] = str(e)
            self.alerts.emit("warn", "sync.unreachable", str(e), dedupe_sec=900)
        except TabletBadResponse as e:
            rep["error"] = str(e)
            self.alerts.emit("alert", "sync.failed", str(e), dedupe_sec=600)
        except Exception as e:
            rep["error"] = f"{type(e).__name__}: {e}"
            self.alerts.emit("alert", "sync.failed", rep["error"], dedupe_sec=600)

        rep["archive_bytes"] = self.archive.size_bytes()
        rep["archive_total"] = self.archive.count()
        rep["duration"] = round(time.time() - started, 2)
        try:
            self.alerts.flush_telegram()
        except Exception:
            pass
        self._write_log(rep)
        return rep

    # ---------------------------------------------------------- helpers
    def _since(self) -> int:
        lasts = self.archive.last_by_source()
        if not lasts:
            return 0
        # Раз в fullSyncHours тянем всё заново: так ловятся расхождения
        # в старых точках и новые счета.
        full_every = int(self.cfg.get("fullSyncHours", 24)) * 3_600_000
        last_full = int(self.state.get("last_full_sync") or 0)
        if full_every <= 0 or int(time.time() * 1000) - last_full >= full_every:
            return 0
        # Глобальный минимум: не пропустить отстающий счёт. Точка ровно на
        # since уже в архиве, поэтому -1 не нужен.
        return max(0, min(int(v) for v in lasts.values()))

    @staticmethod
    def _flatten(rows: dict, since: int) -> list[dict]:
        out: dict[tuple, dict] = {}
        for src, arr in rows.items():
            if not isinstance(arr, list):
                continue
            for p in arr:
                try:
                    ts = int(p[0])
                    val = float(p[1])
                except Exception:
                    continue
                if ts > since and val > 0:
                    out[(src, ts)] = {"source": src, "ts": ts, "value": val}
        return list(out.values())

    @staticmethod
    def _sources_report(rep: dict, points: list[dict]) -> None:
        acc: dict[str, dict] = {}
        for p in points:
            a = acc.setdefault(p["source"], {"new": 0, "from": p["ts"], "to": p["ts"]})
            a["new"] += 1
            a["from"] = min(a["from"], p["ts"])
            a["to"] = max(a["to"], p["ts"])
        rep["sources"] = acc

    def _divergence_alert(self, diverged: list[dict]) -> None:
        first = diverged[:3]
        desc = "; ".join(
            f"{d['source']} {time.strftime('%d.%m %H:%M', time.localtime(d['ts'] / 1000))}: "
            f"планшет {d['tablet']:.2f} / десктоп "
            f"{d.get('hot', d.get('archive', 0)):.2f}"
            for d in first)
        self.alerts.emit("alert", "sync.divergence",
                         f"расхождений: {len(diverged)}. {desc}",
                         details={"items": diverged[:20]}, dedupe_sec=600)

    def _check_tablet(self, now_ms: int, ping: dict, stats: dict) -> None:
        skew = abs(int(ping.get("ts") or now_ms) - now_ms)
        if skew > int(self.cfg.get("clockSkewSec", 60)) * 1000:
            self.alerts.emit("warn", "tablet.clock",
                             f"часы планшета расходятся на {skew // 1000} с",
                             dedupe_sec=3600)

        cpu = float(stats.get("cpu") or 0)
        rss = float(stats.get("rssMb") or 0)
        if cpu >= float(self.cfg.get("resourceAlertCpu", 80)) or \
           rss >= float(self.cfg.get("resourceAlertRssMb", 240)):
            self.alerts.emit("alert", "tablet.resources",
                             f"CPU {cpu:.1f}%, RSS {rss:.0f} МБ", dedupe_sec=900)
        elif cpu >= float(self.cfg.get("resourceWarnCpu", 60)) or \
                rss >= float(self.cfg.get("resourceWarnRssMb", 180)):
            self.alerts.emit("warn", "tablet.resources",
                             f"CPU {cpu:.1f}%, RSS {rss:.0f} МБ", dedupe_sec=900)

        hist_kb = float(stats.get("histBytes") or 0) / 1024
        if hist_kb >= float(self.cfg.get("bufferAlertKb", 400)):
            self.alerts.emit("alert", "tablet.buffer",
                             f"история планшета {hist_kb:.0f} КБ", dedupe_sec=900)
        elif hist_kb >= float(self.cfg.get("bufferWarnKb", 200)):
            self.alerts.emit("warn", "tablet.buffer",
                             f"история планшета {hist_kb:.0f} КБ", dedupe_sec=900)

    def _check_gap(self, now_ms: int, rep: dict, points: list[dict]) -> None:
        if points or not rep.get("tablet_last"):
            return
        last = int(rep["tablet_last"])
        limit = int(self.cfg.get("syncMinutes", 10)) * int(self.cfg.get("gapFactor", 2)) * 60_000
        if now_ms - last > limit:
            self.alerts.emit(
                "warn", "sync.gap",
                f"нет новых точек {(now_ms - last) // 60000} мин (планшет {last})",
                dedupe_sec=1800)

    def _maybe_prune(self, client: TabletClient, rep: dict, hist_bytes: int, now_ms: int) -> None:
        if not self.cfg.get("pruneAfterSync", True):
            return
        if hist_bytes <= int(self.cfg.get("maxTabletKb", 200)) * 1024:
            return
        tablet_last = int(rep.get("tablet_last") or 0)
        if tablet_last and self.archive.max_ts() < tablet_last - 60_000:
            self.alerts.emit("warn", "prune.skipped",
                             "архив ещё не покрывает последнюю точку планшета",
                             dedupe_sec=900)
            return

        cutoff = now_ms - int(self.cfg.get("keepDaysOnTablet", 7)) * 86_400_000
        confirmed = True
        if self.cfg.get("askBeforePrune", True):
            confirmed = bool(self.confirm_prune(cutoff, hist_bytes, tablet_last)) \
                if self.confirm_prune else False
        if not confirmed:
            self.alerts.emit("info", "prune.proposed",
                             f"история {hist_bytes / 1024:.0f} КБ, "
                             f"можно удалить точки старше "
                             f"{time.strftime('%d.%m %H:%M', time.localtime(cutoff / 1000))}",
                             dedupe_sec=1800)
            return
        res = client.prune(cutoff)
        rep["removed"] = int(res.get("removed") or 0)
        rep["left"] = int(res.get("left") or 0)
        self.alerts.emit("info", "prune.done",
                         f"удалено {rep['removed']}, осталось {rep['left']} точек")

    def _pull_tablet_alerts(self, client: TabletClient) -> None:
        since = int(self.state.get("tablet_alerts_ts") or 0)
        try:
            data = client.alerts(since)
        except Exception:
            return
        last = since
        for a in data.get("alerts", []):
            try:
                ts = int(a.get("ts") or 0)
                text = str(a.get("text") or "")
                level = str(a.get("level") or "info")
                if ts > since and text:
                    self.alerts.emit(level, "tablet.alert", text,
                                     origin="tablet", dedupe_sec=600, ts=ts)
                    last = max(last, ts)
            except Exception:
                continue
        self.state["tablet_alerts_ts"] = last
        self._save_state()

    def _check_archive_sizes(self, rep: dict) -> None:
        limit = int(self.cfg.get("maxArchiveMb", 500)) * 1024 * 1024
        if self.archive.size_bytes() > limit:
            self.alerts.emit("warn", "archive.rotate",
                             f"архив {self.archive.size_bytes() / 1048576:.0f} МБ > "
                             f"{self.cfg.get('maxArchiveMb', 500)} МБ", dedupe_sec=86400)
        try:
            if self.archive.vacuum_if_needed():
                self.alerts.emit("info", "archive.vacuum", "SQLite VACUUM выполнен")
        except Exception:
            pass

    def _write_log(self, rep: dict) -> None:
        path = Path(self.cfg["logsDir"]) / "sync_log.csv"
        new = not path.exists()
        try:
            with path.open("a", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                if new:
                    w.writerow([
                        "datetime", "ok", "duration_s", "new_points",
                        "archive_added", "hot_added", "hot_buckets",
                        "removed", "left", "archive_bytes", "archive_total",
                        "diverged", "error"])
                w.writerow([
                    time.strftime("%Y-%m-%d %H:%M:%S"),
                    int(bool(rep["ok"])), rep["duration"], rep["new_points"],
                    rep["archive_added"], rep["hot_added"], rep["hot_buckets"],
                    rep["removed"], rep["left"], rep["archive_bytes"],
                    rep["archive_total"], rep["diverged"], rep["error"]])
        except Exception:
            pass
