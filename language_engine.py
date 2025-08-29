# language_engine.py
# ─────────────────────────────────────────────────────────
# Minimal DeepL-based translator for the prospectus
# Supported UI languages: en, zh, ar, ru, fr, es, de, it
# Uses DeepL API with HTML tag handling to preserve structure.
# ─────────────────────────────────────────────────────────

import os
import requests
from dotenv import load_dotenv

load_dotenv()
DEEPL_API_KEY = os.getenv("DEEPL_API_KEY")

# UI codes → DeepL target codes
# (We prefer British English when translating to English, though in this app
# English is usually the source/original and returned as-is.)
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

DEEPL_ENDPOINT = "https://api-free.deepl.com/v2/translate"  # use api.deepl.com for paid plan


def translate(text: str, target_lang: str) -> str:
    """
    Translate HTML/text to target_lang using DeepL.
    - Returns input unchanged if target is 'en' or unsupported, or if API key missing.
    - Uses tag_handling=html so element structure is preserved.
    """
    if not text:
        return text

    target_lang = (target_lang or "en").lower()
    if target_lang not in SUPPORTED_LANGUAGES:
        return text  # unsupported target → no-op

    # If English requested, we assume the original prospectus is English, so no-op.
    if target_lang == "en":
        return text

    if not DEEPL_API_KEY:
        print("⚠️ DEEPL_API_KEY not set; returning original text.")
        return text

    code = DEEPL_CODES[target_lang]

    try:
        resp = requests.post(
            DEEPL_ENDPOINT,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "auth_key": DEEPL_API_KEY,
                "text": text,
                "target_lang": code,
                # Preserve HTML structure in translated output:
                "tag_handling": "html",
            },
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()

        # DeepL returns a list of translations; we send a single text.
        return data["translations"][0]["text"]
    except Exception as e:
        print(f"DeepL translation error: {e}")
        # Fallback: return original to avoid breaking the page
        return text
