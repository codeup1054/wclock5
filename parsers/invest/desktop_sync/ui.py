"""Tkinter-окно десктоп-синхронизации WClock."""
from __future__ import annotations

import os
import queue
import sys
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from .alerts import AlertManager
from .config import CONFIG_PATH, PKG_DIR, load_config, save_config
from .sync import SyncRunner

def _fix_tcl_env() -> None:
    """Если глобальный TCL_LIBRARY указывает на другой Python — берём свой."""
    base = getattr(sys, "base_prefix", sys.prefix)
    tcl = os.path.join(base, "tcl", "tcl8.6")
    tk = os.path.join(base, "tcl", "tk8.6")
    if os.path.exists(os.path.join(tcl, "init.tcl")):
        os.environ["TCL_LIBRARY"] = tcl
        os.environ["TK_LIBRARY"] = tk


_fix_tcl_env()

BG = "#101418"
FG = "#d6e4ea"
DIM = "#7d8f98"
OK = "#31e378"
WARN = "#ffb020"
ALERT = "#ff5341"


def fmt_ts(ms: int | None) -> str:
    if not ms:
        return "—"
    return time.strftime("%d.%m %H:%M:%S", time.localtime(ms / 1000))


def fmt_bytes(n: int) -> str:
    if n >= 1 << 30:
        return f"{n / (1 << 30):.2f} ГБ"
    if n >= 1 << 20:
        return f"{n / (1 << 20):.1f} МБ"
    return f"{n / 1024:.0f} КБ"


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.cfg = load_config()
        self.title("WClock · синхронизация с планшетом")
        self.geometry("980x640")
        self.configure(bg=BG)
        self.result_q: queue.Queue = queue.Queue()
        self.alerts_mgr = AlertManager(self.cfg["logsDir"], self.cfg)
        self.busy = False
        self.auto_var = tk.BooleanVar(value=bool(self.cfg.get("autoStart", True)))
        self._next_at = 0
        self._build()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(300, self.sync_once)
        self.after(1000, self._tick)

    # ------------------------------------------------------------- UI
    def _build(self) -> None:
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except Exception:
            pass
        style.configure("TFrame", background=BG)
        style.configure("TLabel", background=BG, foreground=FG)
        style.configure("Dim.TLabel", background=BG, foreground=DIM)
        style.configure("TButton", padding=6)
        style.configure("Treeview", background="#161c22", fieldbackground="#161c22",
                        foreground=FG, rowheight=22)
        style.configure("Treeview.Heading", background="#1d252c", foreground=FG)
        style.configure("TCheckbutton", background=BG, foreground=FG)

        top = ttk.Frame(self, padding=10)
        top.pack(fill="x")
        self.lbl_tablet = tk.Label(top, text="● планшет: проверка…", bg=BG, fg=WARN,
                                   font=("Segoe UI", 11, "bold"))
        self.lbl_tablet.pack(side="left")
        self.lbl_last = tk.Label(top, text="последняя синхронизация: —", bg=BG, fg=DIM)
        self.lbl_last.pack(side="left", padx=18)
        self.lbl_archive = tk.Label(top, text="архив: —", bg=BG, fg=DIM)
        self.lbl_archive.pack(side="left")
        self.lbl_next = tk.Label(top, text="", bg=BG, fg=DIM)
        self.lbl_next.pack(side="right")

        bar = ttk.Frame(self, padding=(10, 0))
        bar.pack(fill="x")
        self.btn_sync = ttk.Button(bar, text="Синхронизировать", command=self.sync_once)
        self.btn_sync.pack(side="left")
        ttk.Checkbutton(bar, text="Авто", variable=self.auto_var,
                        command=self._toggle_auto).pack(side="left", padx=10)
        ttk.Button(bar, text="Открыть папку", command=self._open_folder).pack(side="left")
        ttk.Button(bar, text="Настройки", command=self._settings).pack(side="left", padx=6)
        ttk.Button(bar, text="Алерты CSV", command=self._export_alerts).pack(side="left")
        self.lbl_unsent = tk.Label(bar, text="", bg=BG, fg=DIM)
        self.lbl_unsent.pack(side="right")

        body = ttk.Frame(self, padding=10)
        body.pack(fill="both", expand=True)
        body.columnconfigure(0, weight=3)
        body.columnconfigure(1, weight=2)
        body.rowconfigure(0, weight=1)
        body.rowconfigure(1, weight=1)

        self.tree = ttk.Treeview(body, columns=("new", "from", "to"),
                                 show="tree headings", height=8)
        self.tree.heading("#0", text="Счёт")
        self.tree.heading("new", text="Новых")
        self.tree.heading("from", text="С")
        self.tree.heading("to", text="По")
        self.tree.column("#0", width=120)
        self.tree.column("new", width=70, anchor="e")
        self.tree.column("from", width=130, anchor="center")
        self.tree.column("to", width=130, anchor="center")
        self.tree.grid(row=0, column=0, sticky="nsew", padx=(0, 8))

        self.alerts_tree = ttk.Treeview(body, columns=("time", "level", "code", "text"),
                                       show="headings", height=8)
        for col, title, width in (("time", "Время", 110), ("level", "Ур.", 55),
                                  ("code", "Код", 130), ("text", "Сообщение", 300)):
            self.alerts_tree.heading(col, text=title)
            self.alerts_tree.column(col, width=width, anchor="w")
        self.alerts_tree.grid(row=0, column=1, sticky="nsew")

        self.log = tk.Text(body, bg="#0c1014", fg=FG, insertbackground=FG,
                           font=("Consolas", 9), height=9)
        self.log.grid(row=1, column=0, columnspan=2, sticky="nsew", pady=(8, 0))

        self.status = tk.Label(self, text="готов", bg=BG, fg=DIM, anchor="w", padx=10)
        self.status.pack(fill="x", pady=(0, 6))
        self._refresh_alerts()

    # ---------------------------------------------------------- actions
    def _open_folder(self) -> None:
        import os
        os.startfile(self.cfg["archiveDir"])  # noqa: S606 (Windows)

    def _export_alerts(self) -> None:
        try:
            path = self.alerts_mgr.export_csv()
            self._log(f"CSV: {path}")
        except Exception as e:
            messagebox.showerror("Алерты", str(e))

    def _toggle_auto(self) -> None:
        self.cfg["autoStart"] = bool(self.auto_var.get())
        save_config(self.cfg)
        self._next_at = time.time() + self._interval()
        self._log("авто: " + ("вкл" if self.auto_var.get() else "выкл"))

    def _interval(self) -> float:
        return max(1, int(self.cfg.get("syncMinutes", 10))) * 60.0

    def _settings(self) -> None:
        win = tk.Toplevel(self)
        win.title("Настройки синхронизации")
        win.configure(bg=BG)
        fields = [
            ("host", "Планшет (host)"),
            ("port", "LAN-порт"),
            ("syncMinutes", "Период сверки, мин"),
            ("keepDaysOnTablet", "Хранить на планшете, сут"),
            ("maxTabletKb", "Порог prune, КБ"),
            ("telegramToken", "Telegram bot token"),
            ("telegramChatId", "Telegram chat id"),
            ("telegramProxy", "Telegram proxy (опц.)"),
        ]
        vars_ = {}
        for i, (key, label) in enumerate(fields):
            tk.Label(win, text=label, bg=BG, fg=FG).grid(row=i, column=0, sticky="w",
                                                         padx=8, pady=4)
            var = tk.StringVar(value=str(self.cfg.get(key, "")))
            vars_[key] = var
            tk.Entry(win, textvariable=var, width=42).grid(row=i, column=1, padx=8, pady=4)

        def save():
            for key, var in vars_.items():
                raw = var.get().strip()
                if key in ("port", "syncMinutes", "keepDaysOnTablet", "maxTabletKb"):
                    try:
                        self.cfg[key] = int(raw)
                    except ValueError:
                        continue
                else:
                    self.cfg[key] = raw
            save_config(self.cfg)
            self._next_at = time.time() + self._interval()
            self._log(f"настройки сохранены: {CONFIG_PATH}")
            win.destroy()

        tk.Button(win, text="Сохранить", command=save, bg="#1d252c", fg=FG,
                  relief="flat", padx=16, pady=6).grid(row=len(fields), column=1,
                                                      sticky="e", padx=8, pady=10)

    # ------------------------------------------------------------- sync
    def sync_once(self) -> None:
        if self.busy:
            return
        self.busy = True
        self.btn_sync.state(["disabled"])
        self.status.configure(text="синхронизация…", fg=WARN)
        threading.Thread(target=self._worker, daemon=True).start()
        self.after(200, self._poll)

    def _worker(self) -> None:
        runner = SyncRunner(self.cfg, confirm_prune=self._confirm_prune,
                            log=self._log)
        try:
            rep = runner.run()
        except Exception as e:
            rep = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        finally:
            runner.close()
        self.result_q.put(rep)

    def _poll(self) -> None:
        try:
            rep = self.result_q.get_nowait()
        except queue.Empty:
            self.after(250, self._poll)
            return
        self.busy = False
        self.btn_sync.state(["!disabled"])
        self._apply(rep)
        self._next_at = time.time() + self._interval()

    def _apply(self, rep: dict) -> None:
        ok = bool(rep.get("ok"))
        t = rep.get("tablet") or {}
        if ok:
            self.lbl_tablet.configure(
                text=f"● {self.cfg['host']}:{self.cfg['port']} · {t.get('version', '?')}",
                fg=OK)
        else:
            self.lbl_tablet.configure(
                text=f"● планшет недоступен · {rep.get('error', '')[:60]}", fg=ALERT)
        self.lbl_last.configure(
            text=f"последняя синхронизация: {time.strftime('%d.%m %H:%M:%S')}")
        self.lbl_archive.configure(
            text=f"архив: {fmt_bytes(rep.get('archive_bytes', 0))} · "
                 f"{rep.get('archive_total', 0)} точек")
        self.status.configure(
            text=(f"ok · новых {rep.get('new_points', 0)}, архив +{rep.get('archive_added', 0)}, "
                  f"БД +{rep.get('hot_added', 0)}, удалено {rep.get('removed', 0)}, "
                  f"{rep.get('duration', 0)} с")
            if ok else f"ошибка: {rep.get('error', '')}",
            fg=OK if ok else ALERT)

        self.tree.delete(*self.tree.get_children())
        for src, a in sorted((rep.get("sources") or {}).items()):
            self.tree.insert("", "end", text=src, values=(
                a.get("new", 0), fmt_ts(a.get("from")), fmt_ts(a.get("to"))))
        self._refresh_alerts()
        self._log_line(
            f"{time.strftime('%H:%M:%S')} "
            f"{'OK' if ok else 'FAIL'} new={rep.get('new_points', 0)} "
            f"arch+={rep.get('archive_added', 0)} db+={rep.get('hot_added', 0)} "
            f"prune={rep.get('removed', 0)} {rep.get('error', '')}")

    # --------------------------------------------------------- callbacks
    def _confirm_prune(self, cutoff_ms: int, hist_bytes: int, last_ms: int) -> bool:
        ev = threading.Event()
        answer = {"ok": False}

        def ask():
            text = (f"История планшета {hist_bytes / 1024:.0f} КБ.\n\n"
                    f"Удалить точки старше "
                    f"{time.strftime('%d.%m %H:%M', time.localtime(cutoff_ms / 1000))}?\n"
                    f"Архив уже содержит данные по {fmt_ts(last_ms)}.")
            answer["ok"] = messagebox.askyesno("Очистка планшета", text, parent=self)
            ev.set()

        self.after(0, ask)
        ev.wait(timeout=120)
        return answer["ok"]

    def _refresh_alerts(self) -> None:
        try:
            rows = self.alerts_mgr.recent(30)
            unsent = self.alerts_mgr.unsent_count()
        except Exception:
            return
        self.alerts_tree.delete(*self.alerts_tree.get_children())
        for a in rows:
            tag = a["level"]
            self.alerts_tree.insert("", "end", values=(
                fmt_ts(a["ts"]), a["level"], a["code"], a["message"][:80]),
                tags=(tag,))
        self.alerts_tree.tag_configure("warn", foreground=WARN)
        self.alerts_tree.tag_configure("alert", foreground=ALERT)
        self.lbl_unsent.configure(text=f"не отправлено в TG: {unsent}")

    def _tick(self) -> None:
        if self.auto_var.get() and not self.busy:
            left = int(self._next_at - time.time())
            if left <= 0:
                self.sync_once()
            else:
                self.lbl_next.configure(text=f"следующая через {left // 60}:{left % 60:02d}")
        else:
            self.lbl_next.configure(text="авто выкл")
        self.after(1000, self._tick)

    def _log(self, msg: str) -> None:
        self.after(0, lambda: self._log_line(msg))

    def _log_line(self, msg: str) -> None:
        self.log.insert("end", msg + "\n")
        self.log.see("end")

    def _on_close(self) -> None:
        try:
            self.alerts_mgr.close()
        except Exception:
            pass
        self.destroy()


def run_ui() -> None:
    App().mainloop()
