# language_engine.py
# ─────────────────────────────────────────────────────────
# Minimal DeepL-based translator for the prospectus
# Supported UI languages: en, zh, ar, ru, fr, es, de, it
# Preserves HTML structure using tag_handling=html
# Includes: endpoint auto-select, retries, chunking for long HTML,
#           optional debug logging via DEBUG_TRANSLATION=1
# ─────────────────────────────────────────────────────────

from __future__ import annotations

import os
import time
import requests
from typing import List
from dotenv import load_dotenv

load_dotenv()

DEEPL_API_KEY = os.getenv("DEEPL_API_KEY", "").strip()
DEBUG = os.getenv("DEBUG_TRANSLATION", "0") == "1"

# Auto-select endpoint based on key (DeepL Free keys typically end with ':fx')
def _select_endpoint(key: str) -> str:
    if key and not key.endswith(":fx"):
        return "https://api.deepl.com/v2/translate"
    return "https://api-free.deepl.com/v2/translate"

DEEPL_ENDPOINT = _select_endpoint(DEEPL_API_KEY)

# UI → DeepL codes (prefer EN-GB for British English)
DEEPL_CODES = {
    "en": "EN-GB",
    "zh": "ZH",
    "ar": "AR",
    "ru": "RU",
    "fr": "FR",
    "es": "ES",
    "de": "DE",
    "it": "IT",
}
SUPPORTED_LANGUAGES = set(DEEPL_CODES.keys())

# Chunking: DeepL copes with large inputs, but chunking keeps requests snappy
# and avoids hitting any practical limits. We split on safe boundaries.
_MAX_CHARS_PER_REQUEST = 4500  # conservative; keeps payloads small and quick


def _log(msg: str) -> None:
    if DEBUG:
        print(msg)


def _split_into_chunks(html: str, max_len: int) -> List[str]:
    """Split HTML into chunks near tag/space boundaries to avoid breaking tags."""
    if len(html) <= max_len:
        return [html]

    chunks: List[str] = []
    start = 0
    n = len(html)
    while start < n:
        end = min(start + max_len, n)
        # try not to cut through an entity or tag
        cut = html.rfind(">", start, end)
        if cut == -1:
            cut = html.rfind(" ", start, end)
        if cut == -1 or cut <= start + int(max_len * 0.6):
            cut = end
        chunks.append(html[start:cut])
        start = cut
    return chunks


def _post_deepl(texts: List[str], target_code: str) -> List[str]:
    """Call DeepL with one or more text fields."""
    assert DEEPL_API_KEY, "DEEPL_API_KEY missing"
    session = requests.Session()

    # Build repeated 'text' fields while keeping form-encoding
    data = [("auth_key", DEEPL_API_KEY), ("target_lang", target_code), ("tag_handling", "html")]
    for t in texts:
        data.append(("text", t))

    # Retry with exponential backoff on transient errors / rate limits
    backoff = 1.0
    for attempt in range(4):
        try:
            _log(f"[DeepL] POST {DEEPL_ENDPOINT} → target={target_code}, items={len(texts)}, total_bytes={sum(len(t) for t in texts)}")
            r = session.post(
                DEEPL_ENDPOINT,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                data=data,
                timeout=30,
            )
            if r.status_code == 200:
                j = r.json()
                outs = [t["text"] for t in j.get("translations", [])]
                if len(outs) != len(texts):
                    # Defensive: if DeepL merges/splits unexpectedly, join results
                    return ["".join(outs)]
                return outs

            # Handle common error statuses
            body_preview = r.text[:300]
            _log(f"[DeepL] ❌ status={r.status_code} body={body_preview!r}")

            # 429/456 = rate limit; 5xx = transient
            if r.status_code in (429, 456) or (500 <= r.status_code < 600):
                time.sleep(backoff)
                backoff *= 2
                continue

            # 4xx other than rate-limit: likely auth or bad request; do not retry
            break
        except requests.RequestException as e:
            _log(f"[DeepL] ❌ exception: {e!r}")
            time.sleep(backoff)
            backoff *= 2

    # Final fallback: return originals to avoid blanking the page
    return texts


def translate(text: str, target_lang: str) -> str:
    """
    Translate HTML/text to target_lang using DeepL.
    - Returns input unchanged if target is 'en', unsupported, or if API key missing.
    - Uses tag_handling=html so element structure is preserved.
    - Splits very large HTML into safe chunks and reassembles.
    """
    if not text:
        _log("[DeepL] SKIP empty text")
        return text

    lang = (target_lang or "en").lower()
    if lang == "en":
        _log("[DeepL] SKIP lang=en (no translation)")
        return text
    if lang not in SUPPORTED_LANGUAGES:
        _log(f"[DeepL] SKIP unsupported lang={lang}")
        return text
    if not DEEPL_API_KEY:
        _log("[DeepL] ❌ MISSING DEEPL_API_KEY — returning original")
        return text

    code = DEEPL_CODES[lang]

    # Chunk and translate
    chunks = _split_into_chunks(text, _MAX_CHARS_PER_REQUEST)
    if len(chunks) == 1:
        outs = _post_deepl([chunks[0]], code)
        result = outs[0] if outs else text
        _log(f"[DeepL] ✅ ok, out_bytes={len(result)}")
        return result

    results: List[str] = []
    for i in range(0, len(chunks), 10):  # batch up to 10 chunks per request
        batch = chunks[i:i + 10]
        outs = _post_deepl(batch, code)
        # If DeepL returned fewer items (rare), pad with originals to be safe
        if len(outs) != len(batch):
            outs = outs + batch[len(outs):]
        results.extend(outs)

    final = "".join(results)
    _log(f"[DeepL] ✅ ok (chunked), out_bytes={len(final)}")
    return final
