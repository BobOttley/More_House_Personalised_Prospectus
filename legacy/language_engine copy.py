# language_engine.py — safe HTML fragment translator with DeepL batching
import os, re, requests
from typing import List, Tuple

DEEPL_API_KEY = os.getenv("DEEPL_API_KEY", "").strip()
DEEPL_URL = "https://api-free.deepl.com/v2/translate" if DEEPL_API_KEY else None

LANG_MAP = {
    "en": "en", "en-gb": "en", "en-us": "en",
    "ar": "ar", "ru": "ru", "fr": "fr", "es": "es", "de": "de", "it": "it",
    "zh": "zh", "zh-cn": "zh", "zh-hans": "zh", "zh-hant": "zh"
}
RTL = {"ar"}

BRAND_TOKENS = {"PEN.ai", "PEN", "Cognitive College", "More House", "PEN Reply"}

def normalise_lang(s: str) -> str:
    if not s:
        return "en"
    return LANG_MAP.get(s.strip().lower(), "en")

def is_rtl(lang: str) -> bool:
    return normalise_lang(lang) in RTL


# ---------- DeepL batching ----------

def _deepl_batch(texts: List[str], lang: str) -> List[str]:
    """Translate a list of strings. If no key, passthrough (English or unchanged)."""
    lang = normalise_lang(lang)
    if not texts:
        return texts
    if not DEEPL_API_KEY or not DEEPL_URL or lang == "en":
        return texts
    data = [("text", t) for t in texts]
    try:
        r = requests.post(
            DEEPL_URL,
            data=data,
            params={"auth_key": DEEPL_API_KEY, "target_lang": lang.upper()},
            timeout=20,
        )
        r.raise_for_status()
        out = r.json().get("translations", [])
        return [out[i].get("text", texts[i]) for i in range(len(texts))]
    except Exception:
        # Fail safe: if DeepL errors, return source text
        return texts


# ---------- Protection helpers (brands & templating) ----------

TOKEN_RE = re.compile("|".join(re.escape(bt) for bt in sorted(BRAND_TOKENS, key=len, reverse=True))) if BRAND_TOKENS else None
BRACK_RE = re.compile(r"(\{\{.*?\}\}|\[\[.*?\]\])", re.S)

def _protect_brands(s: str) -> Tuple[str, List[str]]:
    if not s or not TOKEN_RE:
        return s, []
    bag: List[str] = []
    def sub(m):
        i = len(bag)
        bag.append(m.group(0))
        return f"__PENBRAND_{i}__"
    return TOKEN_RE.sub(sub, s), bag

def _restore_brands(s: str, bag: List[str]) -> str:
    for i, val in enumerate(bag):
        s = s.replace(f"__PENBRAND_{i}__", val)
    return s

def _protect_brackets(s: str) -> Tuple[str, List[str]]:
    if not s:
        return s, []
    bag: List[str] = []
    def sub(m):
        i = len(bag)
        bag.append(m.group(0))
        return f"__PENPROT_{i}__"
    return BRACK_RE.sub(sub, s), bag

def _restore_brackets(s: str, bag: List[str]) -> str:
    for i, val in enumerate(bag):
        s = s.replace(f"__PENPROT_{i}__", val)
    return s


# ---------- Public helpers (string + HTML fragment) ----------

def translate_text(text: str, lang: str, brand_tokens=BRAND_TOKENS) -> str:
    """Translate a single text string with brand/bracket protection."""
    if not text or not text.strip():
        return text
    lang = normalise_lang(lang)
    if lang == "en":
        return text
    s1, brands = _protect_brands(text)
    s2, bracks = _protect_brackets(s1)
    out = _deepl_batch([s2], lang)[0]
    out = _restore_brackets(out, bracks)
    out = _restore_brands(out, brands)
    return out

def should_skip_text(text: str) -> bool:
    """Skip pure whitespace/tokens/numbers-only fragments to reduce API noise."""
    if not text or not text.strip():
        return True
    if len(text.strip()) <= 1:
        return True
    # Pure numbers/punctuation
    if re.fullmatch(r"[\W_]+", text, flags=re.U):
        return True
    if re.fullmatch(r"\s*[\d\.\,\:\-\+\(\)%\s]+\s*", text):
        return True
    return False


def translate_html_fragment(html: str, lang: str) -> str:
    """
    Very safe: preserves tags exactly; translates only visible text between tags.
    Skips <script>/<style> content. Adds <html lang> and dir="rtl" (Arabic).
    """
    lang = normalise_lang(lang)
    if lang == "en" or not html or not html.strip():
        return html

    # Split into alternating [text, <tag>, text, <tag>...]
    parts = re.split(r"(<[^>]+>)", html)
    out: List[str] = []
    jobs: List[str] = []
    jobs_idx: List[int] = []
    jobs_brandbags: List[List[str]] = []
    jobs_brackbags: List[List[str]] = []

    in_script = False
    in_style = False

    def is_opening(tagname: str, t: str) -> bool:
        return bool(re.match(rf"<\s*{tagname}\b", t, re.I)) and not t.startswith("</")
    def is_closing(tagname: str, t: str) -> bool:
        return bool(re.match(rf"<\s*/\s*{tagname}\b", t, re.I))

    for p in parts:
        if p.startswith("<"):
            t = p
            # Track script/style context
            if is_opening("script", t): in_script = True
            if is_closing("script", t): in_script = False
            if is_opening("style", t):  in_style = True
            if is_closing("style", t):  in_style = False
            out.append(t)
            continue

        # Text node
        if in_script or in_style:
            out.append(p)
            continue
        if should_skip_text(p):
            out.append(p)
            continue

        s1, brandbag = _protect_brands(p)
        s2, brackbag = _protect_brackets(s1)

        jobs_idx.append(len(out))
        jobs_brandbags.append(brandbag)
        jobs_brackbags.append(brackbag)
        jobs.append(s2)
        out.append("")  # placeholder

    # Translate all queued text parts
    if jobs:
        translated = _deepl_batch(jobs, lang)
        for i, s in enumerate(translated):
            s = _restore_brackets(s, jobs_brackbags[i])
            s = _restore_brands(s, jobs_brandbags[i])
            out[jobs_idx[i]] = s

    html2 = "".join(out)

    # Ensure <html lang=".."> (don’t duplicate)
    if re.search(r"<html\b", html2, re.I):
        # Remove any existing lang attr then set the one we want
        html2 = re.sub(r'(<html\b[^>]*?)\s+lang="[^"]*"', r"\1", html2, flags=re.I)
        html2 = re.sub(r"(<html\b)([^>]*?)>", rf'\1 lang="{lang}"\2>', html2, flags=re.I)
        if is_rtl(lang):
            if re.search(r'<html[^>]*\bdir=', html2, re.I):
                html2 = re.sub(r'(<html\b[^>]*\b)dir="[^"]*"', r'\1dir="rtl"', html2, flags=re.I)
            else:
                html2 = re.sub(r"(<html\b)([^>]*?)>", r'\1 dir="rtl"\2>', html2, flags=re.I)
        else:
            # remove dir if present and not RTL
            html2 = re.sub(r'(<html\b[^>]*\b)dir="[^"]*"', r"\1", html2, flags=re.I)

    # Mark selected language (for debugging)
    if re.search(r"</head>", html2, re.I):
        html2 = re.sub(r"</head>", f'<meta name="penai-lang" content="{lang}"></head>', html2, count=1, flags=re.I)

    return html2
