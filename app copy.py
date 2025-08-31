#!/usr/bin/env python3
"""
PEN.ai Prospectus Translator — unified, production-safe app.py

• Serves HTML prospectuses from /public (or project root as fallback)
• On-the-fly translation via language_engine.translate_html_fragment()
• Preserves JS/CSS/iframes and all tracking (no stripping!)
• Arabic pages get dir="rtl"
• Add ?translate=off to bypass translation for quick testing
"""

import os
import logging
from flask import Flask, request, make_response, send_from_directory
from dotenv import load_dotenv
from language_engine import normalise_lang, translate_html_fragment

# ──────────────────────────────────────────────────────────────────────────────
# Bootstrap
# ──────────────────────────────────────────────────────────────────────────────
load_dotenv()

app = Flask(__name__)

# Logging (simple, readable)
logging.basicConfig(
    level=logging.INFO,
    format="[PEN.ai] %(levelname)s: %(message)s"
)
log = logging.getLogger("penai")

# File locations
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
if not os.path.isdir(PUBLIC_DIR):
    log.warning("public/ directory not found next to app.py. Will also try project root for files.")

# Supported languages (clamped in middleware)
SUPPORTED_LANGS = {"en", "zh", "ar", "ru", "fr", "es", "de", "it"}


# ──────────────────────────────────────────────────────────────────────────────
# Request-scoped language detection
# ──────────────────────────────────────────────────────────────────────────────
@app.before_request
def _set_lang():
    lang_raw = request.args.get("lang", "en")
    lang = normalise_lang(lang_raw)
    if lang not in SUPPORTED_LANGS:
        lang = "en"
    # Stash on request for later use
    request._pen_lang = lang


# ──────────────────────────────────────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    # Simple landing/health response
    return (
        "<h1>PEN.ai Prospectus Translator</h1>"
        "<p>Try: <code>/prospectus/prospectus_template.html?lang=fr</code></p>"
        "<p>Debug: add <code>?translate=off</code> to view without translation.</p>"
    ), 200

@app.route("/prospectus/<path:filename>")
def serve_prospectus(filename):
    """
    Serve HTML pages in a modifiable Response (so after_request can translate).
    For non-HTML assets, stream directly from disk.
    Tries ./public/<file> first, then ./<file> (project root).
    """
    # Candidate search paths
    candidates = [
        os.path.join(PUBLIC_DIR, filename),
        os.path.join(BASE_DIR, filename),
    ]
    abs_path = next((p for p in candidates if os.path.isfile(p)), None)

    if not abs_path:
        log.error(f"404 – not found: {filename} (searched: {candidates})")
        return "Prospectus not found", 404

    # For HTML we return a normal Response (not streamed) to allow mutation later
    if filename.lower().endswith((".html", ".htm")):
        try:
            with open(abs_path, "r", encoding="utf-8") as f:
                html = f.read()
        except Exception as e:
            log.error(f"Failed to read HTML file: {abs_path} ({e})")
            return "Failed to read file", 500

        resp = make_response(html, 200)
        resp.headers["Content-Type"] = "text/html; charset=utf-8"
        resp.headers["X-Robots-Tag"] = "noindex, nofollow"
        resp.direct_passthrough = False  # crucial: allow after_request to modify
        log.info(f"Served HTML: {abs_path} (len={len(html)})")
        return resp

    # Non-HTML assets (CSS/JS/images/PDF/etc.)
    resp = send_from_directory(os.path.dirname(abs_path), os.path.basename(abs_path))
    resp.headers["X-Robots-Tag"] = "noindex, nofollow"
    log.info(f"Served asset: {abs_path}")
    return resp


@app.route("/_diag")
def diag():
    """
    Quick health check that exercises the translation path for a tiny HTML snippet.
    Shows selected lang and whether translation altered the sample (or was skipped).
    """
    lang = getattr(request, "_pen_lang", "en")
    sample = "<!doctype html><html><head><title>T</title></head><body><p>Hello from More House, Knightsbridge.</p></body></html>"
    out = translate_html_fragment(sample, lang)
    changed = int(out != sample and lang != "en")
    return f"lang={lang}<br>sample_changed={changed}", 200


# ──────────────────────────────────────────────────────────────────────────────
# Response translation (HTML only)
# ──────────────────────────────────────────────────────────────────────────────
@app.after_request
def _translate_response(resp):
    """
    Translate HTML when lang != en and ?translate!=off.
    Never break delivery: on any error or empty result, fall back to original HTML.
    """
    try:
        if request.args.get("translate", "").lower() == "off":
            return resp

        lang = getattr(request, "_pen_lang", "en")
        ctype = (resp.headers.get("Content-Type") or "").lower()

        if (
            lang != "en"
            and resp.status_code == 200
            and "text/html" in ctype
            and resp.direct_passthrough is False
        ):
            original = resp.get_data(as_text=True) or ""
            if not original.strip():
                # Nothing to translate; return as-is
                return resp

            log.info(f"Translating -> {lang} (len={len(original)})")
            translated = translate_html_fragment(original, lang)

            if translated and translated.strip():
                resp.set_data(translated)
                resp.headers.setdefault("Cache-Control", "public, max-age=60")
                resp.headers["Vary"] = "Accept-Language"
                log.info(f"Translation complete (len={len(translated)})")
            else:
                log.warning("Translator returned empty/whitespace; serving original HTML.")
                resp.set_data(original)

    except Exception as e:
        log.error(f"ERROR during translation: {e} — serving original HTML.")
        # Make sure the original body is still present
        if not (resp.get_data(as_text=True) or "").strip():
            resp.set_data("<!doctype html><title>Error</title><body>Temporary translation error.</body>")
    return resp


# ──────────────────────────────────────────────────────────────────────────────
# Entrypoint
# ──────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    # Render sets PORT automatically; local default is 5000
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True)
