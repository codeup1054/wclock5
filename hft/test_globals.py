#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Статический тест контракта globals для hft SPA.

Ловит ошибки "Cannot read/set properties of undefined" (undefined window.X)
и "cannot read property X of undefined" для межфайловых зависимостей:

  1. Каждый доступ `window.X.y` — X должен быть определён через
     `window.X = ...` в этом же или более раннем по порядку подключения файле,
     либо доступ защищён guard-ом `if (window.X)` / `window.X &&`.
  2. Порядок подключения в index.html согласован: файл-defining загружается
     раньше файлов-consuming (на top-level, не внутри функций).

Запуск:  python hft/test_globals.py   (или из корня репо)
TODO:     Node недоступен локально, поэтому используется упрощённый лексер.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, "hft", "templates", "index.html")

# window.Document/интерфейсы браузера и внешние CDN-глобалы — не наши контракты
ALLOWED_GLOBALS = {
    "window", "document", "location", "navigator", "localStorage",
    "sessionStorage", "history", "self", "screen", "fetch", "XMLHttpRequest",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "requestAnimationFrame", "cancelAnimationFrame", "addEventListener",
    "console", "JSON", "Math", "Date", "RegExp", "Error", "Promise",
    "Object", "Array", "String", "Number", "Boolean", "parseInt", "parseFloat",
    "isNaN", "Infinity", "NaN", "undefined", "Symbol", "WeakMap", "Map", "Set",
    "CustomEvent", "Event", "FormData", "URLSearchParams", "Blob",
    "URL", "FileReader", "TextEncoder", "TextDecoder", "performance",
    "Intl", "structuredClone",
    # Chart.js + crosshair CDN
    "Chart", "Crosshair",
    # SunCalc (CDN) — панель «Часы» hft_clock.js
    "SunCalc",
    # jQuery намокан я в wclock, но в hft не подключается; страховка
    "jQuery", "$",
}

# Read-only браузерные свойства window (никогда не присваиваются кодом)
WINDOW_READONLY = {
    "devicePixelRatio", "innerWidth", "innerHeight", "outerWidth", "outerHeight",
    "screenX", "screenY", "screenLeft", "screenTop", "screen",
    "navigator", "location", "history", "self", "top", "parent",
    "scrollX", "scrollY", "pageXOffset", "pageYOffset",
    "frameElement", "visualViewport", "localStorage", "sessionStorage",
    "origin", "isSecureContext", "getComputedStyle", "getSelection",
    "addEventListener", "removeEventListener", "dispatchEvent", "getElementById",
    "querySelector", "querySelectorAll", "open", "close", "focus", "blur",
    "scrollTo", "scroll", "alert", "confirm", "prompt", "matchMedia",
    "requestAnimationFrame", "cancelAnimationFrame", "devicePixelRatio",
    "performance", "caches", "customElements", "fetch",
    "stop", "postMessage", "setInterval", "clearInterval", "setTimeout", "clearTimeout",
    "requestIdleCallback", "cancelIdleCallback", "print",
}

RE_SCRIPT = re.compile(r"<script[^>]+src=[\"']([^\"']+)[\"']", re.I)
RE_WINDOW_USE = re.compile(r"window\s*\.\s*([A-Za-z_$][\w$]*)")


def strip_js(src):
    """Возвращает код, в котором строки/комментарии/regex заменены пробелами.
    Длина и переносы строк исходника сохраняются (важно для номеров строк)."""
    buf = list(src)
    i, n = 0, len(src)
    prev = ""

    def blank(j):
        if buf[j] != "\n":
            buf[j] = " "

    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if c == "/" and nxt in "/":
            while i < n and src[i] != "\n":
                blank(i)
                i += 1
            prev = " "
            continue
        if c == "/" and nxt == "*":
            buf[i] = " "; buf[i + 1] = " "
            i += 2
            while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
                blank(i)
                i += 1
            if i < n:
                buf[i] = " "
            if i + 1 < n:
                buf[i + 1] = " "
            i += 2
            prev = " "
            continue
        if c == "'" or c == '"':
            buf[i] = " "
            i += 1
            while i < n:
                if src[i] == "\\":
                    blank(i)
                    if i + 1 < n:
                        blank(i + 1)
                    i += 2
                    continue
                if src[i] == quote(c):
                    blank(i)
                    i += 1
                    break
                blank(i)
                i += 1
            prev = "s"
            continue
        if c == "`":
            buf[i] = " "
            i += 1
            while i < n:
                if src[i] == "\\":
                    if i + 1 < n:
                        blank(i + 1)
                    blank(i)
                    i += 2
                    continue
                if src[i] == "`":
                    blank(i)
                    i += 1
                    break
                blank(i)
                i += 1
            prev = "s"
            continue
        if c == "/" and not (prev.isalnum() or prev in "_$)]") and prev != "":
            buf[i] = " "
            i += 1
            in_class = False
            while i < n:
                ch = src[i]
                if ch == "\\":
                    blank(i)
                    if i + 1 < n:
                        blank(i + 1)
                    i += 2
                    continue
                if ch == "[":
                    in_class = True
                elif ch == "]":
                    in_class = False
                elif ch == "/" and not in_class:
                    blank(i)
                    i += 1
                    break
                blank(i)
                i += 1
            while i < n and src[i] in "gimsuy":
                blank(i)
                i += 1
            prev = " "
            continue
        if c in " \t\r":  # пробелы: prev не обновляем, чтобы не путать деление с regex
            i += 1
            continue
        prev = c
        i += 1
    return "".join(buf)


def quote(open_q):
    return open_q  # ' и " самозакрывающиеся


def is_definition(line):
    """`window.X =` — определение (не `window.X.y =`)."""
    m = re.search(r"window\s*\.\s*([A-Za-z_$][\w$]*)\s*=", line)
    if not m:
        return None
    name = m.group(1)
    # `window.X ==`, `window.X ===`, `window.X =>` считать определением нельзя
    rest = line[m.end():].lstrip()
    if rest.startswith("=") or rest.startswith(">"):
        return None
    return name


def is_guarded(lines, idx, name):
    """Является ли доступ `window.X` на строке idx guard-проверкой."""
    line = lines[idx]
    # Доступ в виде `if (window.X)` / `window.X && ...` / `window.X ? ...`
    guard_re = re.compile(
        r"(if|typeof)\s*\(\s*window\s*\.\s*%s\s*\)" % re.escape(name)
    )
    and_re = re.compile(r"window\s*\.\s*%s\s*(&&|\|\||\?|:)" % re.escape(name))
    if guard_re.search(line) or and_re.search(line):
        return True
    # guard на предыдущей строке: `var pm = window.X;` где pm используется ниже
    # (этого достаточно для практических целей)
    if idx > 0 and re.search(
        r"=\s*(window\s*\.\s*%s)\s*;" % re.escape(name), lines[idx - 1]
    ):
        return True
    return False


def script_list():
    """Возвращает список локальных (не CDN) скриптов в порядке подключения."""
    if not os.path.exists(INDEX):
        print("FAIL: index.html не найден:", INDEX)
        sys.exit(2)
    html = open(INDEX, encoding="utf-8").read()
    scripts = []
    for src in RE_SCRIPT.findall(html):
        if src.startswith("http"):
            continue
        src = src.split("?", 1)[0]  # cache-busting ?v=... не влияет на путь
        path = src.lstrip("/")
        rel = os.path.normpath(os.path.join("hft", path))
        full = os.path.join(ROOT, rel)
        if not os.path.exists(full):
            print("FAIL: скрипт %s (%s) отсутствует" % (src, rel))
            sys.exit(2)
        scripts.append(rel)
    return scripts


def main():
    scripts = script_list()
    if not scripts:
        print("FAIL: не найдено ни одного локального скрипта")
        sys.exit(2)

    print("Порядок подключения:")
    for i, s in enumerate(scripts):
        print("  [%d] %s" % (i, s))

    state = {}   # name -> {defined_by: set(filename), used_by: set(filename)}
    problems = []

    for rel in scripts:
        src = strip_js(open(os.path.join(ROOT, rel), encoding="utf-8").read())
        lines = src.split("\n")
        for i, line in enumerate(lines):
            for m in RE_WINDOW_USE.finditer(line):
                name = m.group(1)
                if name in ALLOWED_GLOBALS or name in WINDOW_READONLY:
                    continue
                rec = state.setdefault(name, {"defined_by": set(), "used_by": set()})
                if is_definition(line) and is_definition(line) == name:
                    rec["defined_by"].add(rel)
                else:
                    rec["used_by"].add(rel)

    # contract check: любое использование должно иметь определение раньше/в том же файле
    index_of = {s: i for i, s in enumerate(scripts)}
    for name, rec in sorted(state.items()):
        if rec["used_by"] and not rec["defined_by"]:
            problems.append(
                "window.%s используется в %s, но НИГДЕ не определён через `window.%s =`"
                % (name, ", ".join(sorted(rec["used_by"])), name)
            )
            continue
        for uf in rec["used_by"]:
            defs = sorted(rec["defined_by"], key=lambda f: index_of[f])
            first_def = defs[0]
            # использование должно быть в том же файле или позже определения
            if index_of[uf] < index_of[first_def]:
                problems.append(
                    "window.%s используется в %s, но определяется только в %s "
                    "(подключается позже!)"
                    % (name, uf, first_def)
                )

    if problems:
        print("\nFAIL — проблемы контракта:")
        for p in problems:
            print("  - " + p)
        sys.exit(1)

    defined = [n for n, r in state.items() if r["defined_by"]]
    only_def = [n for n in defined if not state[n]["used_by"]]
    print("\nOK — контрактов %d, экспортируемых глобалов: %s"
          % (len(defined), ", ".join(sorted(defined))))
    if only_def:
        print("  (не используются другим файлом, ок: %s)" % ", ".join(sorted(only_def)))
    return 0


if __name__ == "__main__":
    sys.exit(main())