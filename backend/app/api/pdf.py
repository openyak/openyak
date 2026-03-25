"""Centralized PDF generation using xhtml2pdf.

Provides markdown_to_pdf() and html_to_pdf() for both session and artifact exports.
"""

from __future__ import annotations

import io
import logging
import os
import re
from pathlib import Path

import markdown
from reportlab.lib.fonts import addMapping
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from xhtml2pdf import pisa
from xhtml2pdf.default import DEFAULT_FONT

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Font discovery & registration (cross-platform system fonts via ReportLab API)
# ---------------------------------------------------------------------------

import sys as _sys

_WINDOWS_FONT_DIR = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"

# Each entry: (font_path, is_ttc)
# TTC files (TrueType Collections) need subfontIndex=0

def _build_font_candidates() -> tuple[list[tuple[Path, bool]], list[tuple[Path, bool]]]:
    """Build platform-specific font candidate lists."""
    body: list[tuple[Path, bool]] = []
    mono: list[tuple[Path, bool]] = []

    if _sys.platform == "darwin":
        # macOS CJK body fonts
        body = [
            (Path("/System/Library/Fonts/STHeiti Medium.ttc"), True),
            (Path("/System/Library/Fonts/Supplemental/Songti.ttc"), True),
            (Path("/System/Library/Fonts/STHeiti Light.ttc"), True),
            (Path("/Library/Fonts/Arial Unicode.ttf"), False),
            (Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"), False),
        ]
        # macOS monospace fonts
        mono = [
            (Path("/System/Library/Fonts/Menlo.ttc"), True),
            (Path("/System/Library/Fonts/Monaco.ttf"), False),
            (Path("/System/Library/Fonts/Supplemental/Courier New.ttf"), False),
        ]
    elif _sys.platform == "win32":
        # Windows CJK body fonts
        body = [
            (_WINDOWS_FONT_DIR / "msyh.ttc", True),
            (_WINDOWS_FONT_DIR / "simhei.ttf", False),
            (_WINDOWS_FONT_DIR / "simsun.ttc", True),
            (_WINDOWS_FONT_DIR / "malgun.ttf", False),
            (_WINDOWS_FONT_DIR / "arial.ttf", False),
        ]
        # Windows monospace fonts
        mono = [
            (_WINDOWS_FONT_DIR / "consola.ttf", False),
            (_WINDOWS_FONT_DIR / "cour.ttf", False),
            (_WINDOWS_FONT_DIR / "lucon.ttf", False),
        ]
    else:
        # Linux CJK body fonts
        _linux_font_dirs = [
            Path("/usr/share/fonts"),
            Path("/usr/local/share/fonts"),
            Path(os.path.expanduser("~/.fonts")),
        ]
        for d in _linux_font_dirs:
            for name in ("NotoSansCJK-Regular.ttc", "NotoSansSC-Regular.otf",
                         "wqy-microhei.ttc", "DroidSansFallbackFull.ttf"):
                for candidate in d.rglob(name):
                    body.append((candidate, name.endswith(".ttc")))
            for name in ("DejaVuSansMono.ttf", "NotoSansMono-Regular.ttf", "LiberationMono-Regular.ttf"):
                for candidate in d.rglob(name):
                    mono.append((candidate, False))

    return body, mono


_BODY_FONT_CANDIDATES, _MONO_FONT_CANDIDATES = _build_font_candidates()

_BODY_FAMILY = "OpenYakBody"
_BODY_CSS_NAME = "openyakbody"  # CSS font-family name (lowercase for xhtml2pdf)
_MONO_FAMILY = "OpenYakMono"
_MONO_CSS_NAME = "openyakmono"

_fonts_registered = False
_body_font_family = "Helvetica"
_mono_font_family = "Courier"


def _try_register_font(family: str, css_name: str, font_path: Path, is_ttc: bool) -> bool:
    """Register a font with ReportLab + xhtml2pdf. Returns True on success.

    Three-step registration required for xhtml2pdf to use the font:
    1. Register TTFont with ReportLab pdfmetrics
    2. Add bold/italic mappings via reportlab.lib.fonts.addMapping
    3. Add to xhtml2pdf's DEFAULT_FONT dict so CSS font-family resolves
    """
    rl_name = f"{family}_00"
    try:
        kwargs = {"subfontIndex": 0} if is_ttc else {}
        pdfmetrics.registerFont(TTFont(rl_name, str(font_path), **kwargs))

        # Map all style variants to the same font (no true bold/italic files)
        for bold in (0, 1):
            for italic in (0, 1):
                addMapping(css_name, bold, italic, rl_name)

        # Register in xhtml2pdf's font lookup dict
        DEFAULT_FONT[css_name] = rl_name

        return True
    except Exception as e:
        log.debug("Skipping font %s: %s", font_path, e)
        return False


def _register_fonts() -> None:
    """Register the best available system fonts with ReportLab (once).

    Uses direct ReportLab API instead of @font-face CSS to avoid
    path-handling issues on Windows.
    """
    global _fonts_registered, _body_font_family, _mono_font_family
    if _fonts_registered:
        return

    # Register body font (first available CJK-capable font)
    for font_path, is_ttc in _BODY_FONT_CANDIDATES:
        if font_path.exists() and _try_register_font(_BODY_FAMILY, _BODY_CSS_NAME, font_path, is_ttc):
            _body_font_family = _BODY_CSS_NAME
            log.info("PDF body font: %s from %s", _BODY_FAMILY, font_path)
            break
    else:
        log.warning("No CJK body font found — Chinese/Japanese/Korean text may not render correctly")

    # Register monospace font
    for font_path, is_ttc in _MONO_FONT_CANDIDATES:
        if font_path.exists() and _try_register_font(_MONO_FAMILY, _MONO_CSS_NAME, font_path, is_ttc):
            _mono_font_family = _MONO_CSS_NAME
            log.info("PDF mono font: %s from %s", _MONO_FAMILY, font_path)
            break

    _fonts_registered = True


# ---------------------------------------------------------------------------
# CSS template
# ---------------------------------------------------------------------------

_PDF_CSS_TEMPLATE = """\
@page {{
    size: A4;
    margin: 2cm 2.5cm;
}}

body {{
    font-family: {body_font};
    font-size: 11pt;
    line-height: 1.6;
    color: #1a1a1a;
    word-wrap: break-word;
    overflow-wrap: break-word;
}}

/* Headings */
h1 {{ font-size: 20pt; margin-top: 24pt; margin-bottom: 12pt; font-weight: 700; color: #111; }}
h2 {{ font-size: 16pt; margin-top: 20pt; margin-bottom: 10pt; font-weight: 600; color: #222; }}
h3 {{ font-size: 13pt; margin-top: 16pt; margin-bottom: 8pt; font-weight: 600; color: #333; }}
h4, h5, h6 {{ font-size: 11pt; margin-top: 12pt; margin-bottom: 6pt; font-weight: 600; }}

/* Paragraphs */
p {{ margin-top: 0; margin-bottom: 8pt; word-wrap: break-word; overflow-wrap: break-word; }}

/* Tables */
table {{
    width: 100%;
    border-collapse: collapse;
    margin-top: 12pt;
    margin-bottom: 12pt;
    font-size: 10pt;
}}
thead {{ display: table-header-group; }}
th {{
    background-color: #f0f0f0;
    border: 1pt solid #bbb;
    padding: 6pt 8pt;
    text-align: left;
    font-weight: 600;
}}
td {{
    border: 1pt solid #ddd;
    padding: 5pt 8pt;
    vertical-align: top;
    word-wrap: break-word;
    overflow-wrap: break-word;
}}
tr {{ page-break-inside: avoid; }}

/* Code blocks */
pre {{
    background-color: #f5f5f5;
    border: 1pt solid #e0e0e0;
    padding: 10pt;
    margin-top: 8pt;
    margin-bottom: 8pt;
    font-size: 9pt;
    line-height: 1.4;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-family: {mono_font};
}}
code {{
    background-color: #f0f0f0;
    padding: 1pt 3pt;
    font-size: 9.5pt;
    font-family: {mono_font};
}}
pre code {{
    background-color: transparent;
    padding: 0;
}}

/* Blockquotes */
blockquote {{
    border-left: 3pt solid #ccc;
    margin-left: 0;
    margin-right: 0;
    padding-left: 12pt;
    color: #555;
    font-style: italic;
    margin-top: 8pt;
    margin-bottom: 8pt;
}}

/* Horizontal rules */
hr {{
    border: none;
    border-top: 1pt solid #ddd;
    margin-top: 16pt;
    margin-bottom: 16pt;
}}

/* Lists */
ul, ol {{ margin-top: 4pt; margin-bottom: 8pt; padding-left: 20pt; }}
li {{ margin-bottom: 3pt; }}

/* Links */
a {{ color: #0066cc; text-decoration: underline; }}

/* Strong/emphasis */
strong {{ font-weight: 700; }}
em {{ font-style: italic; }}
"""

_HTML_TEMPLATE = """\
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
{css}
</style>
</head>
<body>
{body}
</body>
</html>"""


# ---------------------------------------------------------------------------
# HTML post-processing
# ---------------------------------------------------------------------------


def _add_alternating_row_styles(html: str) -> str:
    """Add inline background-color on even <tr> rows.

    xhtml2pdf does not support :nth-child CSS selectors, so we apply
    alternating row colors via inline styles.
    """

    def _style_table(match: re.Match[str]) -> str:
        table_html = match.group(0)
        row_count = 0

        def _style_row(row_match: re.Match[str]) -> str:
            nonlocal row_count
            row_count += 1
            tag = row_match.group(0)
            if row_count % 2 == 0:
                if 'style="' in tag:
                    return tag.replace('style="', 'style="background-color:#fafafa;')
                return tag.replace("<tr", '<tr style="background-color:#fafafa"', 1)
            return tag

        row_count = 0
        return re.sub(r"<tr[^>]*>", _style_row, table_html)

    return re.sub(r"<table[\s\S]*?</table>", _style_table, html)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

_DEFAULT_EXTENSIONS = ["tables", "fenced_code", "codehilite", "toc", "nl2br"]


def html_to_pdf(html_body: str) -> bytes:
    """Convert an HTML body fragment into PDF bytes using xhtml2pdf."""
    _register_fonts()

    # Build full CSS
    full_css = _PDF_CSS_TEMPLATE.format(
        body_font=_body_font_family,
        mono_font=_mono_font_family,
    )

    # Post-process HTML for alternating row styles
    styled_body = _add_alternating_row_styles(html_body)

    # Assemble full HTML document
    full_html = _HTML_TEMPLATE.format(css=full_css, body=styled_body)

    buf = io.BytesIO()
    pisa_status = pisa.CreatePDF(full_html, dest=buf, encoding="utf-8")

    if pisa_status.err:
        log.warning("xhtml2pdf reported %d error(s) during conversion", pisa_status.err)

    return buf.getvalue()


def markdown_to_pdf(
    md_content: str,
    extensions: list[str] | None = None,
) -> bytes:
    """Convert markdown text to PDF bytes.

    Uses full markdown extensions by default (tables, fenced_code, etc.).
    """
    exts = extensions if extensions is not None else _DEFAULT_EXTENSIONS
    html_body = markdown.markdown(md_content, extensions=exts)
    return html_to_pdf(html_body)
