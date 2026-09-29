# news_scorer.py — оценка текстов по влиянию на коммодити-фонды.
# Выход: семейство -> score (-100..100) + уверенность (0..1) + базис.
# Уровни: словарь (lex) → локальная модель (model) → LLM (llm) для «дорогих» случаев.
import re
import socket

socket.setdefaulttimeout(10)

# ── Управляемые параметры анализа ─────────────────────────────
DEFAULT_PARAMS = {
    "half_life_hours": 12.0,      # полураспад влияния текста на агрегат
    "min_conf": 0.35,             # порог уверенности для сигнала
    "agg": "weighted",            # weighted | median | peak
    "norm": 100.0,                # нормализация шкалы сигнала
    "weights": {                  # доли категорий в итоговом score
        "monetary": 0.30,
        "commodity": 0.25,
        "geopolitics": 0.25,
        "macro": 0.10,
        "demand": 0.10,
    },
}
_CAT_ORDER = ["monetary", "commodity", "geopolitics", "macro", "demand"]


def set_params(p):
    """Обновляет глобальные параметры анализа (в т.ч. после загрузки из БД)."""
    global DEFAULT_PARAMS
    out = dict(DEFAULT_PARAMS)
    for k, v in p.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k].update(v)
        else:
            out[k] = v
    DEFAULT_PARAMS = out

# Лексикон: категория → {pos: [(шаблон, вес)], neg: [(шаблон, вес)]}.
# Шаблон — набор токенов; между ними подставляется \w*\s* (устойчиво к склонениям и пробелам).
LEXICON = {
    "monetary": {
        "pos": [
            ("снизил ставк", "снижен ставк", "понижен ставк", "мягк поли", 2.0),
            ("rate cut", "rate cuts", "easing", "qe", "dovish", "negative rate", 2.0),
            ("низк ставк", "снижен ключев", "стимул", "печат денег", 1.5),
            ("ставк сниз", "ставку сниз", 1.5),
        ],
        "neg": [
            ("повысил ставк", "повышен ставк", "ужесточ", "жестк поли", 2.0),
            ("rate hike", "rate hikes", "hawkish", "tightening", "qt", "tighter policy", 2.0),
            ("ставк повышен", "ставку повышен", "высок ставк", "сверхвысок инфляц", 1.5),
        ],
    },
    "commodity": {
        "pos": [
            ("запас ниже", "запас сниз", "сокращен запас", "drawdown", 2.0),
            ("дефицит", "нехватк", "shortage", "дефицит поставок", 2.0),
            ("сокращен добыч", "снижен добыч", "сбо поставок", "прекращен поставок", 2.0),
            ("опек сократ", "opec cut", "opec cuts", 1.5),
            ("запас нефт", "crude inventor", "отчет eia", "отчёт eia", "eia запас", 1.0),
            ("платформ останов", "поломк трубопровод", "strike mine", 1.0),
        ],
        "neg": [
            ("запас выше", "запас вырос", "запас увеличен", "рост запас", 2.0),
            ("профицит", "избыт", "surplus", "перепроизводств", "переизбыт", 2.0),
            ("полн запас", "запас полн", "запасы высок", 1.5),
            ("рост добыч", "добыч раст", "повышен добыч", "output up", 1.5),
            ("opec boost", "opec raise", "opec increase", "увелич добыч", 1.5),
            ("отчет eia запас", "запасы eia", "запасы выше ожид", 1.0),
        ],
    },
    "geopolitics": {
        "pos": [
            ("санкци введ", "санкци", 2.0),
            ("санкци нефт", "санкци рос", "санкци метал", 2.0),
            ("эмбарго", "блокад", "запрет импорт", "запрет экспорт", 2.0),
            ("военн", "войн", "конфликт", "кризис", 2.0),
            ("срыв поставок", "supply disruption", "прекращен экспорт", 1.5),
        ],
        "neg": [
            ("перемир", "de-escalat", "снят санкци", 2.0),
            ("мирн соглашен", "урегулирован", "разрядк", "смягчен санкци", 2.0),
            ("возобновлен поставок", "восстановлен поставок", 1.5),
            ("мирн переговор", "переговор", "потеплен отношен", 1.0),
        ],
    },
    "macro": {
        "pos": [
            ("слаб доллар", "доллар ослаб", "паден доллар", "dollar weak", 1.5),
            ("pmi выше", "экономик рост", "делов активност раст", "currency weak", 1.0),
            ("инфляц сниж", "индек цен сниж", 1.0),
        ],
        "neg": [
            ("сильн доллар", "доллар укреп", "dollar strong", "dollar surge", 1.5),
            ("рецесс", "промышлен спад", "экономик замедл", "замедлен экономик", 1.0),
            ("спад производств", "инфляц высок", "перегрев экономик", 1.0),
        ],
    },
    "demand": {
        "pos": [
            ("рост спроса", "спрос раст", "спрос вырос", "demand up", 1.5),
            ("потреблен раст", "electric demand", "electricity demand", 1.5),
            ("промышлен вырос", "manufacturing up", "электромобил", "ev sales", 1.0),
            ("потреблен нефт", "потреблен газ", 1.0),
        ],
        "neg": [
            ("паден спроса", "спрос сниз", "спрос упал", "спрос падает", "demand fall", 1.5),
            ("demand drops", "demand weak", "weak demand", 1.5),
            ("потреблен сниз", "замедлен промышлен", "снижен потреблен", 1.0),
            ("спад промышленност", "закрыт завод", 1.0),
        ],
    },
}


def _make():
    """Строит скомпилированные regex из фраз: каждый слот = (фразы..., вес);
    каждая фраза компилируется отдельно, токены внутри склеиваются \w*\s*."""
    compiled = {}
    for cat, sides in LEXICON.items():
        compiled[cat] = {}
        for side in ("pos", "neg"):
            out = []
            for slot in sides[side]:
                *phrases, w = slot
                for ph in phrases:
                    toks = ph.split()
                    rx = r"\s*".join(t + r"\w*" for t in toks)
                    out.append((re.compile(rx, re.I), w))
            compiled[cat][side] = out
    return compiled


_COMPILED = _make()

# Семейства: маркеры БЕЗ жёстких границ слов (русские склонения), англ. — границы есть.
FAMILY_MARKERS = {
    "GOLD": ("золот|gold|gltrub", ["золот", "gold", "gltrub"]),
    "SILV": ("серебр|silver|slvrub", ["серебр", "silver", "slvrub"]),
    "COPPER": ("мед(и|ь|е|ью|ной)|copper|cathode", ["мед", "copper"]),
    "PLATINUM_SPOT": ("платин|platinum|pltrub", ["платин", "platinum", "pltrub"]),
    "BRENT": ("brent|нефт|брент|crude|wti", ["brent", "нефт", "брент", "crude", "wti"]),
    "NGAS": ("природн.{0,8}газ|natural.{0,8}gas|ngas|газ", ["газ", "natural gas", "ngas"]),
}
GLOBAL_DRIVERS = ("ставк", "infl", "инфляц", "fed", "фрс", "снцб", "доллар", "dollar",
                  "санкци", "sanction", "войн", "war", "qe", "ставка", "rate", "ценб")

_bull_re = re.compile(r"(подытож|раст|выше|поддерж|позитив|bullish|gains?|rise|rises?|strengthen|усилен|близко|дорожает)", re.I)
_bear_re = re.compile(r"(дешевеет|обвал|упад|падени|негатив|bearish|falls?|drops?|weakens|слабеет|давлен|продав|проседает)", re.I)


def _catscore(text, cat):
    s = 0.0
    hits = []
    for side in ("pos", "neg"):
        sign = 1 if side == "pos" else -1
        for rx, w in _COMPILED[cat][side]:
            m = rx.findall(text)
            if m:
                s += w * sign
                hits.append((cat, side, m[0][:28]))
    return s, hits


def _impact(text):
    total = 0.0
    hits = []
    for cat in _CAT_ORDER:
        sc, hh = _catscore(text, cat)
        total += sc
        hits += hh
    if not hits:
        return 0.0, 0.0, []
    conf = min(0.3 + 0.12 * min(len(hits), 8), 0.95)
    return total, conf, hits


def _fam_match(text, fam):
    return bool(re.search(FAMILY_MARKERS[fam][0], text, re.I))


def _global_driver(text):
    return sum(1 for t in GLOBAL_DRIVERS if re.search(r"\b" + t, text, re.I))


def score_text(text, families=None, params=None):
    params = params or DEFAULT_PARAMS
    families = families or list(FAMILY_MARKERS)
    W = params.get("weights", DEFAULT_PARAMS["weights"])
    total_w = sum(W.get(c, 0) for c in _CAT_ORDER) or 1
    impact, conf, hits = _impact(text)
    gdv = _global_driver(text)
    out = []
    for fam in families:
        if fam not in FAMILY_MARKERS:
            continue
        direct = _fam_match(text, fam)
        if not direct and (gdv == 0 or conf == 0):
            continue  # не про семейство, либо нет ни одного влияющего термина → не сигнал
        fam_coef = 1.0 if direct else 0.35
        low_conf = min(conf, 0.5) if not direct else conf
        scale = (100.0 / 9.0) * (total_w / 3.0)
        score = impact * fam_coef * scale
        if not direct:
            score *= 0.7
        direction = 0.0
        if _bull_re.search(text) and not _bear_re.search(text):
            direction = 0.12
        elif _bear_re.search(text) and not _bull_re.search(text):
            direction = -0.12
        score = max(-100.0, min(100.0, score + direction * 100 * fam_coef))
        if direct and conf == 0:
            continue
        out.append((fam, round(score, 1), round(max(low_conf, 0.1), 2), "lex",
                    {"cat_hits": hits, "impact": round(impact, 2)}))
    return out


def _try_model(text, families):
    try:
        from news_model import predict
        return predict(text, families)
    except Exception:
        return None


def _try_llm(text, families):
    try:
        from news_llm import prompt_score
        return prompt_score(text, families)
    except Exception:
        return None


def score_text_multi(text, families=None, use_model=True, use_llm=False):
    base = score_text(text, families)
    fam_scores = {f: (s, c, b, ft) for f, s, c, b, ft in base}
    if use_model:
        r = _try_model(text, list(fam_scores))
        if r:
            for f, s, c in r:
                if c >= 0.6 and f in fam_scores:
                    fam_scores[f] = (s, c, "model", {})
    if use_llm:
        r = _try_llm(text, list(fam_scores))
        if r:
            for f, s, c in r:
                if c >= 0.6 and f in fam_scores:
                    fam_scores[f] = (s, c, "hybrid", {})
    return [(f, s, c, b, ft) for f, (s, c, b, ft) in fam_scores.items()]