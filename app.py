#!/usr/bin/env python3
"""
PEN.ai Prospectus Translator
──────────────────────────────────────────────
• Serves personalised HTML prospectuses
• On-the-fly translation with DeepL API
• Supported languages: en, zh, ar, ru, fr, es, de, it
• Preserves branding, structure, and tracking
• Protects brand tokens from translation
• Arabic gets dir="rtl"
──────────────────────────────────────────────
"""

import os
from functools import lru_cache
from flask import Flask, request, send_from_directory
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from language_engine import translate

print("✅ Prospectus translation server starting …")
load_dotenv()

app = Flask(__name__)
SUPPORTED_LANGS = {"en", "zh", "ar", "ru", "fr", "es", "de", "it"}
SAFE_CONTENT_TAGS = {
    "p","h1","h2","h3","h4","ul","ol","li","strong","em","br",
    "blockquote","table","thead","tbody","tr","td","th","figure","figcaption","span","a"
}

BRAND_TOKENS = [
    # School / brand
    "More House School", "More House", "PEN.ai", "The Good Schools Guide", "Good Schools Guide",

    # Places / venues
    "Knightsbridge", "London", "Hyde Park", "South Bank", "City of London", "West End",
    "Natural History Museum", "Science Museum", "Victoria & Albert Museum", "V&A",
    "Tate", "National Gallery",

    # Programmes / quals
    "A Level", "A Levels", "GCSE", "Cambridge Technicals", "UCAS",
    "Extended Project Qualification (EPQ)", "EPQ",
    "Creative Leadership Ethical Enterprise Programme (CLEEP)", "CLEEP",
    "Duke of Edinburgh Award Scheme", "Duke of Edinburgh", "Oxbridge",

    # Universities
    "King's College London", "Imperial College London", "University College London", "UCL",
    "London School of Economics", "LSE", "St Andrews", "Durham", "Bath", "Exeter",
    "Warwick", "Bristol", "Edinburgh", "Cambridge", "Central Saint Martins", "RADA"
]

# Build regex map once
import re

_TOKEN_MAP = []
for i, token in enumerate(BRAND_TOKENS):
    key = f"__BRAND_{i}__"
    # word-boundary pattern; allow apostrophes/ampersands inside tokens
    # e.g. King's, V&A; we escape the token for safety
    pattern = r'(?<!\w)' + re.escape(token) + r'(?!\w)'
    _TOKEN_MAP.append((re.compile(pattern, re.IGNORECASE), token, key))

def protect_brands(html: str):
    placeholders = {}
    out = html
    for rx, original, key in _TOKEN_MAP:
        # replace all case-insensitive matches with a single placeholder key
        if rx.search(out):
            out = rx.sub(key, out)
            placeholders[key] = original  # store canonical form
    return out, placeholders

def restore_brands(html: str, placeholders: dict):
    out = html
    for key, value in placeholders.items():
        out = out.replace(key, value)
    return out

def set_html_lang_dir(soup: BeautifulSoup, lang_code: str):
    html_tag = soup.find("html") or soup.new_tag("html")
    if not soup.find("html"):
        soup.insert(0, html_tag)
    html_tag["lang"] = lang_code
    if lang_code == "ar":
        html_tag["dir"] = "rtl"
    return soup

@lru_cache(maxsize=256)
def _cached_translation(cache_key: str, lang: str, cleaned_html: str):
    return translate(cleaned_html, lang)

# ── Routes ───────────────────────────────────────────────

@app.route("/prospectus/<path:filename>")
def serve_prospectus(filename):
    lang = (request.args.get("lang") or "en").lower()
    abs_dir = os.path.join(os.getcwd(), "public")  # <-- public folder
    abs_path = os.path.join(abs_dir, filename)

    print(f"[route] /prospectus -> file={filename} lang={lang} dir={abs_dir}")

    if not os.path.exists(abs_path):
        print(f"[route] NOT FOUND: {abs_path}")
        return "Prospectus not found", 404

    if lang == "en":
        resp = send_from_directory(abs_dir, filename)
        resp.headers["X-Robots-Tag"] = "noindex, nofollow"
        return resp

    try:
        raw_html = open(abs_path, "r", encoding="utf-8").read()
        soup = BeautifulSoup(raw_html, "html.parser")

        # strip runtime-only nodes
        for tag in soup(["script", "style", "noscript", "iframe", "canvas"]):
            tag.decompose()

        body = soup.body or soup
        for tag in list(body.find_all()):
            if tag.name not in SAFE_CONTENT_TAGS:
                tag.unwrap()

        # protect brand tokens
        protected_html, placeholders = protect_brands(str(body))

        # debug: what we're sending to DeepL
        print(f"[route] cleaned_html bytes={len(protected_html)} lang={lang}")
        print(f"[route] cleaned_html first200={protected_html[:200]!r}")

        # translate (cached)
        translated_inner = _cached_translation(filename, lang, protected_html)
        print(f"[route] translated first200={translated_inner[:200]!r}")

        # restore protected content
        translated_inner = restore_brands(translated_inner, placeholders)

        # reinsert into original shell
        shell = BeautifulSoup(raw_html, "html.parser")
        if shell.body:
            shell.body.clear()
            tmp = BeautifulSoup(translated_inner, "html.parser")
            for node in tmp.contents:
                shell.body.append(node)

        # set lang/dir + open links in new tab
        shell = set_html_lang_dir(shell, lang)
        for a in shell.find_all("a"):
            a["target"] = "_blank"

        html_out = str(shell)
        return (html_out, 200, {
            "Content-Type": "text/html; charset=utf-8",
            "X-Robots-Tag": "noindex, nofollow"
        })
    except Exception as e:
        print(f"❌ prospectus translation failed: {e}")
        return "Error translating prospectus", 500

@app.route("/_diag")
def diag():
    # Simple health-check: confirms the key is loaded and translation works
    from language_engine import translate, DEEPL_API_KEY
    lang = (request.args.get("lang") or "fr").lower()
    sample = "<p>Hello from Knightsbridge</p>"
    out = translate(sample, lang)
    masked = (DEEPL_API_KEY[:4] + "…" + DEEPL_API_KEY[-4:]) if DEEPL_API_KEY else "MISSING"
    return f"key={masked}<br>lang={lang}<br>sample_in={sample}<br>sample_out={out}"

#!/usr/bin/env python3
"""
PEN.ai Prospectus Translator
──────────────────────────────────────────────
• Serves personalised HTML prospectuses
• On-the-fly translation via DeepL (if DEEPL_API_KEY is set)
• Supported languages: en, zh, ar, ru, fr, es, de, it
• Preserves branding & tracking; won’t translate <script>/<style> or data-protect blocks
• Adds dir="rtl" for Arabic
• Fast per-file/per-language caching with file mtime awareness
──────────────────────────────────────────────
"""

import os
import time
import hashlib
from functools import lru_cache
from flask import Flask, request, send_from_directory, abort, Response
from bs4 import BeautifulSoup, NavigableString, Comment
from dotenv import load_dotenv

from language_engine import translate_text, normalise_lang, should_skip_text

print("✅ Flask server starting …")
load_dotenv()

app = Flask(__name__)

# Adjust to your folder structure
PUBLIC_DIR = os.path.join(os.path.dirname(__file__), "public")

SUPPORTED_LANGS = {"en", "zh", "ar", "ru", "fr", "es", "de", "it"}
RTL_LANGS = {"ar"}

# Tags whose inner text we may translate (we still skip protected spans etc.)
TRANSLATABLE_TAGS = {
    "p", "h1", "h2", "h3", "h4", "h5", "h6",
    "li", "span", "strong", "em", "small", "blockquote", "figcaption",
    "button", "label", "a", "td", "th", "caption", "summary", "details",
    "dd", "dt", "div"  # div is allowed but we only touch direct text nodes, not HTML
}

# Attributes we translate when present
TRANSLATABLE_ATTRS = {"title", "alt", "aria-label", "placeholder"}

# Simple brand tokens you do NOT want translated
BRAND_TOKENS = {
    "PEN.ai", "PEN", "Cognitive College", "More House", "More House", "PEN Reply"
}

def _file_mtime(path: str) -> float:
    try:
        return os.path.getmtime(path)
    except FileNotFoundError:
        return 0.0

def _cache_key(path: str, lang: str) -> str:
    m = f"{os.path.abspath(path)}::{_file_mtime(path)}::{lang}"
    return hashlib.sha256(m.encode("utf-8")).hexdigest()

@lru_cache(maxsize=256)
def _get_translated_html_cached(abs_path: str, lang: str, cache_marker: str) -> str:
    """Cache by absolute path + language + mtime marker (passed in as cache_marker)."""
    with open(abs_path, "r", encoding="utf-8") as f:
        html = f.read()
    if lang == "en":
        return html  # no-op for English

    soup = BeautifulSoup(html, "html.parser")

    # Respect explicit opt-out: anything with data-protect or data-no-translate
    def node_protected(el) -> bool:
        return el and (el.has_attr("data-protect") or el.has_attr("data-no-translate"))

    # Set dir="rtl" for Arabic
    if lang in RTL_LANGS:
        if soup.html:
            soup.html["dir"] = "rtl"
    else:
        if soup.html and "dir" in soup.html.attrs:
            del soup.html["dir"]

    # Walk text nodes inside allowed tags only, skipping scripts/styles/comments
    for tag in soup.find_all(True):
        if tag.name in ("script", "style"):
            continue
        if node_protected(tag):
            continue

        if tag.name in TRANSLATABLE_TAGS:
            # Translate attributes first
            for attr in TRANSLATABLE_ATTRS:
                if tag.has_attr(attr):
                    original = tag.get(attr, "")
                    if original and not should_skip_text(original, BRAND_TOKENS):
                        tag[attr] = translate_text(original, lang, BRAND_TOKENS)

            # Now translate direct text nodes
            new_children = []
            for child in tag.children:
                if isinstance(child, NavigableString) and not isinstance(child, Comment):
                    txt = str(child)
                    if should_skip_text(txt, BRAND_TOKENS):
                        new_children.append(child)
                    else:
                        new_children.append(translate_text(txt, lang, BRAND_TOKENS))
                else:
                    new_children.append(child)
            tag.contents = new_children

    # Ensure we reflect the selected language in <html lang="">
    if soup.html:
        soup.html["lang"] = lang

    # Preserve meta markers (handy for tracking)
    head = soup.head or soup.new_tag("head")
    if not soup.head:
        soup.html.insert(0, head)

    meta_lang = soup.new_tag("meta")
    meta_lang.attrs["name"] = "penai-lang"
    meta_lang.attrs["content"] = lang
    head.append(meta_lang)

    return str(soup)

@app.after_request
def add_common_headers(resp: Response):
    # Helps CDNs separate per-language caches
    resp.headers["Vary"] = "Accept-Language, Cookie"
    # Cache translated HTML for a short while at edge
    resp.headers.setdefault("Cache-Control", "public, max-age=60")
    return resp

@app.route("/")
def root_index():
    # Serve a tiny index so Render health checks don’t 404
    return "PEN.ai Prospectus Translator is live.", 200

@app.route("/<path:slug>")
def serve_prospectus(slug: str):
    """
    Serve any pre-rendered prospectus HTML out of /public by slug, with optional ?lang=xx.
    Example: /the-price-family-601243?lang=ru
    """
    lang = normalise_lang(request.args.get("lang", "en"))
    if lang not in SUPPORTED_LANGS:
        lang = "en"

    # Only serve .html files from /public; if no .html, append it.
    safe_slug = slug
    if ".." in safe_slug or safe_slug.startswith("/"):
        abort(404)

    if not safe_slug.endswith(".html"):
        safe_slug += ".html"

    abs_path = os.path.join(PUBLIC_DIR, safe_slug)
    if not os.path.isfile(abs_path):
        # Fall back to static send if present (for assets)
        try:
            return send_from_directory(PUBLIC_DIR, slug)
        except Exception:
            abort(404)

    # Cache key includes file mtime so a new deploy invalidates automatically
    cache_marker = _cache_key(abs_path, lang)

    try:
        html = _get_translated_html_cached(abs_path, lang, cache_marker)
    except Exception as e:
        # Never hard-fail the page; serve original and surface the error in server logs
        print(f"[Translator] ERROR rendering {slug} lang={lang}: {e}")
        with open(abs_path, "r", encoding="utf-8") as f:
            html = f.read()

    # Always text/html; ensure UTF-8
    return Response(html, mimetype="text/html; charset=utf-8")

