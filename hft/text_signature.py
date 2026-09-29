# text_signature.py — Преобразование текстов в сигнатуры влияния на коммодити.
# Подходы:
#   1. TF-IDF + sklearn (быстрый, CPU, без GPU)
#   2. Sentence-transformers (тяжёлый, нужен torch, GPU опционален)
#   3. LLM эмбеддинги (Ollama API, внешний)
#
# Итог: каждая статья → вектор [score_per_family] (-1..1 или -100..100)
import os
import re
import json
import hashlib
import numpy as np
from datetime import datetime

# ── Конфиг ──────────────────────────────────────────────────────
FAMILIES = ["GOLD", "SILV", "COPPER", "PLATINUM_SPOT", "BRENT", "NGAS"]
FAMILY_KEYWORDS = {
    "GOLD":      ["gold", "золото", "goldman", "золотой", "bullion", "xau"],
    "SILV":      ["silver", "серебро", "silver", "серебряный", "xag"],
    "COPPER":    ["copper", "медь", "copper", "медный", "хин"],
    "PLATINUM_SPOT": ["platinum", "платина", "platinum", "платиновый", "xpt"],
    "BRENT":     ["brent", "neft", "нефть", "crude", "oil", "petroleum", "opec", "dto"],
    "NGAS":      ["gas", "газ", "natural gas", "ng", "lnpg"],
}


def _tokenize(text):
    """Простая токенизация для TF-IDF (lowercase + разделение по не-буквам)."""
    text = text.lower()
    text = re.sub(r"[^a-zа-яё0-9]+", " ", text)
    return text.split()


def _load_stopwords():
    """Стоп-слова для TF-IDF (базовый набор для русского/английского)."""
    return set(
        "и в на не с по к для от из за что как это но все его она они мы вы они "
        "быть будет был были бы можем может может между тем так еще уже этот "
        "which the and or is are was were has have had be been being "
        "a an in on at to for of with by from into through during before after "
        "above below between under over up down out off on off over under".split()
    )


class TFIDFSignature:
    """TF-IDF векторизация → усреднение по семействам → вектор влияния.

    Подход:
    1. TF-IDF на корпусе (обучаем один раз)
    2. Для каждой статьи: tfidf重心 → распределение по семействам через ключевые слова
    3. Направление: +1/-1 на основе sentiment-словаря
    """

    def __init__(self):
        from sklearn.feature_extraction.text import TfidfVectorizer
        self.vectorizer = TfidfVectorizer(
            tokenizer=_tokenize,
            max_features=5000,
            min_df=1,
            max_df=0.95,
            sublinear_tf=True,
        )
        self.is_fitted = False
        self._family_vectors = {}  # family → idx → weight
        self._family_indices = {}
        self._build_family_indices()

    def _build_family_indices(self):
        """Строит маппинг family → set(idx) для ключевых слов в словаре TF-IDF."""
        # Будет заполнен после fit на словаре векторайзера
        self._family_vocab = {fam: set() for fam in FAMILIES}

    def fit(self, texts):
        """Обучает TF-IDF на корпусе текстов."""
        corpus = [self._preprocess(t) for t in texts if t and len(t) > 20]
        if not corpus:
            return
        self.vectorizer.fit(corpus)
        vocab = self.vectorizer.vocabulary_
        for fam, keywords in FAMILY_KEYWORDS.items():
            for kw in keywords:
                kw_lower = kw.lower()
                if kw_lower in vocab:
                    self._family_vocab[fam].add(vocab[kw_lower])
        self.is_fitted = True

    def _preprocess(self, text):
        if not text:
            return ""
        return re.sub(r"<[^>]+>", " ", text).strip()

    def transform(self, text):
        """Преобразует текст в вектор влияния [-1, 1] по каждому семейству.

        Возвращает: {family: score}, confidence, features.
        """
        if not self.is_fitted:
            return self._fallback_transform(text)
        processed = self._preprocess(text)
        if not processed or len(processed) < 10:
            return self._fallback_transform(text)
        try:
            tfidf_vec = self.vectorizer.transform([processed])
            arr = tfidf_vec.toarray().flatten()
        except Exception:
            return self._fallback_transform(text)
        results = {}
        for fam in FAMILIES:
            indices = self._family_vocab.get(fam, set())
            if not indices:
                results[fam] = 0.0
                continue
            fam_weights = arr[list(indices)]
            concentration = float(np.sum(fam_weights))
            results[fam] = concentration
        max_abs = max(abs(v) for v in results.values()) or 1.0
        for fam in FAMILIES:
            results[fam] = results[fam] / max_abs
        confidence = min(1.0, float(np.mean(arr[arr > 0]) * 10)) if np.any(arr > 0) else 0.0
        features = {fam: round(results[fam], 3) for fam in FAMILIES if abs(results[fam]) > 0.01}
        return results, confidence, features

    def _fallback_transform(self, text):
        """Словарный fallback когда TF-IDF не обучен."""
        if not text:
            return {fam: 0.0 for fam in FAMILIES}, 0.0, {}
        text_lower = text.lower()
        results = {}
        for fam, keywords in FAMILY_KEYWORDS.items():
            hits = sum(1 for kw in keywords if kw.lower() in text_lower)
            results[fam] = min(1.0, hits * 0.3) if hits else 0.0
        confidence = 0.1
        features = {fam: v for fam, v in results.items() if v > 0}
        return results, confidence, features


class HybridSignature:
    """Гибридный подход: TF-IDF + словарь + направление.

    Использует TF-IDF для концентрации + sentiment-словарь для направления.
    """

    def __init__(self):
        self.tfidf = TFIDFSignature()
        self._bull_words = {
            "рост", "вырос", "повышение", "подорожал", "усиление", "спрос",
            "gain", "rise", "surge", "rally", "strengthen", "bullish", "soar"
        }
        self._bear_words = {
            "падение", "снижение", "дешевеет", "обвал", "слабость", "предложение",
            "fall", "drop", "decline", "crash", "weakness", "bearish", "plunge"
        }

    def fit(self, texts):
        self.tfidf.fit(texts)

    def transform(self, text):
        tfidf_res, tfidf_conf, tfidf_feats = self.tfidf.transform(text)
        text_lower = text.lower() if text else ""
        bull_hits = sum(1 for w in self._bull_words if w in text_lower)
        bear_hits = sum(1 for w in self._bear_words if w in text_lower)
        if bull_hits > bear_hits:
            direction = 0.15
        elif bear_hits > bull_hits:
            direction = -0.15
        else:
            direction = 0.0
        results = {}
        for fam in FAMILIES:
            base = tfidf_res.get(fam, 0.0)
            results[fam] = base + direction
        confidence = min(1.0, tfidf_conf + 0.05)
        features = {fam: round(results[fam], 3) for fam in FAMILIES if abs(results[fam]) > 0.01}
        return results, confidence, features


class LexiconSignature:
    """Словарный подход (текущий в news_scorer.py) для сравнения."""

    def __init__(self):
        pass

    def fit(self, texts):
        pass

    def transform(self, text):
        try:
            import news_scorer
            raw = news_scorer.score_text_multi(text)
            results = {}
            for fam, score, conf, basis, feats in raw:
                results[fam] = score / 100.0  # нормализуем к -1..1
            confidence = max((conf for _, conf, _, _, _ in raw), default=0.0)
            features = {}
            for fam, score, conf, basis, feats in raw:
                if feats:
                    features[fam] = feats
            return results, confidence, features
        except Exception:
            return {fam: 0.0 for fam in FAMILIES}, 0.0, {}


class SignatureBuilder:
    """Фабрика сигнатур: TF-IDF / Hybrid / Lexicon / LLM (заглушка)."""

    @staticmethod
    def create(method="hybrid"):
        if method == "tfidf":
            return TFIDFSignature()
        elif method == "hybrid":
            return HybridSignature()
        elif method == "lexicon":
            return LexiconSignature()
        else:
            raise ValueError(f"unknown method: {method}")


class CorpusManager:
    """Управление корпусом: обучение, кэширование, инкрементальный fit."""

    def __init__(self, db_path=None):
        import news_db
        self._conn = news_db.news_conn()
        self._builders = {}

    def fit_corpus(self, method="hybrid"):
        """Обучает сигнатуру на всех статьях в БД."""
        import news_db
        builder = SignatureBuilder.create(method)
        rows = self._conn.execute(
            "SELECT text, title FROM articles WHERE text != '' OR title != ''"
        ).fetchall()
        texts = [r["text"] or r["title"] for r in rows if r["text"] or r["title"]]
        if texts:
            builder.fit(texts)
        self._builders[method] = builder
        return builder

    def get_builder(self, method="hybrid"):
        if method not in self._builders:
            self.fit_corpus(method)
        return self._builders[method]

    def transform_article(self, article_id, method="hybrid"):
        """Преобразует статью в сигнатуру."""
        builder = self.get_builder(method)
        row = self._conn.execute(
            "SELECT text, title FROM articles WHERE id=?", (article_id,)
        ).fetchone()
        if not row:
            return None
        text = row["text"] or row["title"] or ""
        result, confidence, features = builder.transform(text)
        return {
            "article_id": article_id,
            "method": method,
            "signature": result,
            "confidence": confidence,
            "features": features,
            "ts": datetime.now().isoformat(),
        }

    def transform_all(self, method="hybrid", limit=None):
        """Преобразует все статьи в сигнатуры."""
        builder = self.get_builder(method)
        q = "SELECT id, text, title FROM articles"
        if limit:
            q += f" LIMIT {int(limit)}"
        rows = self._conn.execute(q).fetchall()
        results = []
        for row in rows:
            text = row["text"] or row["title"] or ""
            if text and len(text) > 20:
                sig, conf, feats = builder.transform(text)
                results.append({
                    "article_id": row["id"],
                    "method": method,
                    "signature": sig,
                    "confidence": conf,
                    "features": feats,
                })
        return results


# ── Сравнение подходов ──────────────────────────────────────────
def compare_approaches(texts, methods=None):
    """Сравнивает подходы на заданных текстах.

    Возвращает: {method: {precision, recall, correlation_with_price, latency_ms}}
    """
    if methods is None:
        methods = ["tfidf", "hybrid", "lexicon"]
    results = {}
    for method in methods:
        builder = SignatureBuilder.create(method)
        if method != "lexicon":
            builder.fit(texts)
        start = datetime.now()
        sigs = []
        for text in texts:
            sig, conf, feats = builder.transform(text)
            sigs.append((sig, conf, feats))
        elapsed_ms = (datetime.now() - start).total_seconds() * 1000
        avg_conf = np.mean([c for _, c, _ in sigs]) if sigs else 0
        avg_nonzero = np.mean([
            sum(1 for v in s.values() if abs(v) > 0.01) for s, _, _ in sigs
        ]) if sigs else 0
        results[method] = {
            "avg_confidence": round(float(avg_conf), 3),
            "avg_nonzero_families": round(float(avg_nonzero), 2),
            "total_signatures": len(sigs),
            "latency_ms_per_article": round(elapsed_ms / max(len(sigs), 1), 1),
            "total_latency_ms": round(elapsed_ms, 1),
        }
    return results
