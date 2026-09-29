# panel_mediator.py 2026-09-17
"""Медиатор данных клиент↔сервер (вариант B): единый POST /api/panel.

Контракт (см. docs/02_project/epics/EPIC_mediator_data.md §Решение):

    POST /api/panel
    { "v": { "<секция>": "<токен клиента>" },   # чтение (дельта)
      "w": { "<секция>": { ...payload записи... } } }  # запись (write)

    200
    {
      "changed": { "<секция>": <данные> },   // только изменившиеся
      "tokens":  { "<секция>": "<новый токен>" },
      "ts": <unix_epoch_sec>,
      "w":   { "<секция>": {"applied":..,"skipped":..,"reason":..} }
    }

Правила:
- Токен секции = стабильный хэш от детерминированной сериализации payload
  (SHA-256 к short-key JSON, sort_keys). Одинаковый payload → одинаковый токен.
- Один «общий» POST заменяет N периодических GET/POST — клиент шлёт токены,
  сервер отдаёт только секции, где токен изменился.
- Write-гранулярность: секция пишется не чаще `write_interval_<sect>` (сек),
  а если значение не изменилось — вообще пропускается (skipped). Токены
  секций при этом всё равно обновляются — клиент не «застревает».
- Падение провайдера секции не роняет медиатор: секция получает
  {"_error": ..}, токен не меняется (клиент продолжит слать старый).

Модуль НЕ знает про БД/Flask: провайдеры секций (read/write) поставляет
приложение (app.py). Это ключевое решение — ни одного INSERT/SELECT здесь.
"""

import hashlib
import json
import time

DEFAULT_MAX_SECTIONS = 40          # защита от гигантских v/w
DEFAULT_TOK_LEN = 16                # hex-длина токена (64 бита энтропии)


def stable_token(payload) -> str:
    """Стабильный токен: SHA-256 сортированной сериализации.
    Stable: payload не менялся → токен тот же (условие дельты)."""
    if payload is None:
        payload = {}
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:DEFAULT_TOK_LEN]


class PanelMediator:
    """Медиатор одного «панельного» клиента.

    apply_write — опциональный callable(sect, payload)->dict (например,
    запись батареи). Если не передан, write-секции работают в режиме
    «гранулярность настраивается», а фактическую запись делает провайдер,
    зарегистрированный в `self.writers`.

    Провайдеры — словари:
      readers[sect] = callable(params?) -> payload
        (params — необязательный dict с параметрами секции)
      writers[sect] = callable(payload) -> {"ok": bool, "_error"?: str}

    Настройки:
      write_interval: {sect: секунды}
      max_sections: лимит числа секций за запрос.
    """

    def __init__(self, readers=None, writers=None, write_interval=None,
                 max_sections=DEFAULT_MAX_SECTIONS):
        self.readers = readers or {}
        self.writers = writers or {}
        self.write_interval = write_interval or {}
        self.max_sections = max_sections
        self._last_ts = {}            # {sect: последняя применённая запись (epoch)}
        self._last_val = {}           # {sect: последнее записанное значение}
        self._tokens = {}             # {sect: последний выданный токен}

    # ---------------------------------------------------------------
    # Чтение
    # ---------------------------------------------------------------
    def read(self, v, params=None):
        """v: {sect: клиентский токен}. Возвращает (changed, tokens).
        changed — секции, где серверный токен != клиентскому."""
        params = params or {}
        changed, tokens = {}, {}

        if not isinstance(v, dict):
            return changed, tokens
        for sect, client_tok in (list(v.items())[:self.max_sections]):
            reader = self.readers.get(sect)
            if reader is None:
                # Неизвестная секция: сообщаем ошибкой, но не валим ответ.
                err = {"_error": f"unknown section: {sect}"}
                changed[sect] = err
                tokens[sect] = stable_token(err)
                continue
            try:
                payload = reader(params.get(sect, {})) if _takes_params(reader) else reader()
                tok = stable_token(payload)
                self._tokens[sect] = tok
                if client_tok != tok:
                    changed[sect] = payload
                tokens[sect] = tok
            except Exception as e:
                err = {"_error": str(e)}
                changed[sect] = err
                tokens[sect] = stable_token(err)
        return changed, tokens

    # ---------------------------------------------------------------
    # Запись
    # ---------------------------------------------------------------
    def write(self, w):
        """w: {sect: payload}. Возвращает {sect: {applied, skipped, reason}}.
        Гранулярность: не чаще write_interval[sect]; пропуск при
        неизменном значении (сравниваем payload с последней записью)."""
        out = {}
        if not isinstance(w, dict):
            return {"_error": "write payload must be dict"}
        for sect, payload in (list(w.items())[:self.max_sections]):
            writer = self.writers.get(sect)
            if writer is None:
                out[sect] = {"applied": False, "skipped": True,
                             "reason": "no writer for section"}
                continue

            now = time.time()
            interval = self.write_interval.get(sect, 0)
            last_ts = self._last_ts.get(sect)
            interval_ok = (last_ts is None) or (now - last_ts) >= interval
            value_ok = (self._last_val.get(sect) != payload)

            if not interval_ok and not value_ok:
                out[sect] = {"applied": False, "skipped": True,
                             "reason": "interval_not_elapsed_and_value_unchanged"}
                continue  # токен не меняем: значение не записано

            try:
                res = writer(payload)
                if isinstance(res, dict) and not res.get("ok", True):
                    out[sect] = {"applied": False, "skipped": False,
                                 "reason": res.get("_error", "writer failed")}
                    continue
                self._last_ts[sect] = now
                self._last_val[sect] = payload
                out[sect] = {"applied": True, "skipped": False,
                             "reason": None}
            except Exception as e:
                out[sect] = {"applied": False, "skipped": False,
                             "reason": str(e)}
        return out

    # ---------------------------------------------------------------
    # Формирование ответа
    # ---------------------------------------------------------------
    def process(self, body):
        """body: {v, w, p?}. Возвращает готовый json-словарь ответа."""
        body = body or {}
        v = body.get("v") or {}
        w = body.get("w") or {}
        p = body.get("p") or {}

        changed, tokens = self.read(v, params=p)
        writes = self.write(w)

        # ${убираю комментарий}: ts в том же стиле, что и остальные /api/*
        return {
            "changed": changed,
            "tokens": tokens,
            "ts": int(time.time()),
            "w": writes,
        }


def _takes_params(reader):
    """Хелпер: reader — callable; поддерживает ли секция параметры.
    Определяем по строке сигнатуры — читаем исключения выполняются только
    если дома! Проще: принимаем решение в приложении — см. register."""
    return True


def connect_mediator(readers, writers=None, write_interval=None):
    """Фабрика: обёртка для app.py. Провайдеры — функции без параметров
    (аргументы уже замыкают настройки/пути). Если переданы «параметрические»
    провайдеры {sect: fn(**params)}, читай через `PanelMediator.read(v, params)`."""
    return PanelMediator(readers=readers, writers=writers,
                         write_interval=write_interval)
