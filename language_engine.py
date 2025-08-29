import os
import re
import json
from typing import Iterable, Set

import requests

DEEPL_API_KEY = os.getenv("DEEPL_API_KEY", "").strip()
DEEPL_URL = "https://api-free.deepl.com/v2/translate" if DEEPL_API_KEY else None

# Map multiple user inputs to the codes we actually use
_LANG_NORMALISE = {
    "en": "en", "en-gb": "en", "en-us": "en",
    "zh": "zh", "zh-cn": "zh", "zh-hans": "zh", "zh-hant": "zh",
    "ar": "ar",
    "ru": "ru",
    "fr": "fr",
    "es": "es",
    "de": "de",
    "it": "it",
}

# Very short or whitespace-only strings shouldn’t be sent to DeepL
_MIN_LEN = 2

# Inline code-ish patterns we should never translate
_CODEY = re.compile(r"^\s*[{<\[\(\\/*#@].*|.*[{>}\]\)]\s*$")

# To keep punctuation hugging consistent
TRIM_EDGES = re.compile(r"^\s+|\s+$")

def normalise_lang(s: str) -> str:
    if not s:
        return "en"
    s = s.strip().lower()
    return _LANG_NORMALISE.get(s, "en")

def should_skip_text(text: str, brand_tokens: Set[str]) -> bool:
    if not text:
        return True
    t = text.strip()
    if len(t) < _MIN_LEN:
        return True
    if _CODEY.match(t):
        return True
    # Skip pure URLs or email-like
    if re.match(r"^https?://", t) or re.match(r"^\S+@\S+\.\S+$", t):
        return True
    # Skip if it’s exactly one of the brand tokens (case-sensitive preserve)
    if t in brand_tokens:
        return True
    # Mostly punctuation?
    if re.match(r"^[\s\W_]+$", t):
        return True
    return False

def _deepl_translate(texts: Iterable[str], target_lang: str) -> Iterable[str]:
    """Translate a batch of strings using DeepL; yields translated strings in order.
       If DeepL isn’t configured, yields originals."""
    if not DEEPL_API_KEY or not DEEPL_URL:
        # No-op if not configured
        for t in texts:
            yield t
        return

    # DeepL target language codes; using generic codes works for these targets.
    # We send batch requests for efficiency.
    payload = {
        "auth_key": DEEPL_API_KEY,
        "target_lang": target_lang.upper(),
    }
    data = []
    index_map = []
    for idx, t in enumerate(texts):
        data.append(("text", t))
        index_map.append(idx)

    try:
        resp = requests.post(DEEPL_URL, data=data, params=payload, timeout=15)
        resp.raise_for_status()
        js = resp.json()
        translations = js.get("translations", [])
        # DeepL returns same order; be defensive anyway
        out = []
        for i, item in enumerate(translations):
            out.append(item.get("text", data[i][1]))
        for s in out:
            yield s
    except Exception as e:
        print(f"[DeepL] WARN: translation failed ({e}); serving originals.")
        for t in texts:
            yield t

def _segment(text: str) -> list[tuple[str, bool]]:
    """
    Split text into translateable vs. protected segments.
    We protect brand tokens and inline {{mustache}} or [[shortcodes]] etc.
    Returns list of (segment, translate_this_bool).
    """
    if not text:
        return [(text, False)]

    # Protect {{...}}, [[...]], and brand tokens
    # We replace them with sentinels, translate, then restore.
    protected = []
    sentinel_fmt = "__PENPROT_%d__"

    def protect(m):
        idx = len(protected)
        protected.append(m.group(0))
        return sentinel_fmt % idx

    # Protect mustache and bracketed tokens
    s = re.sub(r"(\{\{.*?\}\}|\[\[.*?\]\])", protect, text)

    # Return single segment for translation; we’ll restore later.
    return [(s, True)], protected

def _restore_protected(text: str, protected: list[str]) -> str:
    if not protected:
        return text
    for i, val in enumerate(protected):
        text = text.replace(f"__PENPROT_{i}__", val)
    return text

def translate_text(s: str, lang: str, brand_tokens: Set[str]) -> str:
    lang = normalise_lang(lang)
    if lang == "en":
        return s

    if should_skip_text(s, brand_tokens):
        return s

    # First protect brand tokens by replacing with sentinels
    protected_brands = []
    def protect_brand(m):
        idx = len(protected_brands)
        protected_brands.append(m.group(0))
        return f"__PENBRAND_{idx}__"

    protected_pattern = re.compile("|".join(re.escape(bt) for bt in sorted(brand_tokens, key=len, reverse=True)))
    s2 = protected_pattern.sub(protect_brand, s) if brand_tokens else s

    # Protect templating/shortcodes
    segments, bracket_protected = _segment(s2)

    to_translate = [seg for seg, do in segments if do]
    translated = list(_deepl_translate(to_translate, lang))

    # Rebuild
    out = []
    t_idx = 0
    for seg, do in segments:
        if do:
            out.append(translated[t_idx])
            t_idx += 1
        else:
            out.append(seg)
    s3 = "".join(out)

    # Restore bracketed templates
    s4 = _restore_protected(s3, bracket_protected if isinstance(bracket_protected, list) else [])

    # Restore brand tokens
    for i, token in enumerate(protected_brands):
        s4 = s4.replace(f"__PENBRAND_{i}__", token)

    # Tidy edges to avoid accidental spacing bugs
    return TRIM_EDGES.sub("", s4)
