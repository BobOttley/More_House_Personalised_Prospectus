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

if __name__ == "__main__":
    app.run(debug=True)

