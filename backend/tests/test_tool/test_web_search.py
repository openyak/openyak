"""Tests for app.tool.builtin.web_search — DuckDuckGo result parsing."""

from __future__ import annotations

from app.tool.builtin.web_search import _parse_ddg_results


class TestParseDdgResults:
    def test_extracts_results(self):
        html = '''
        <a class="result__a" href="https://example.com">Example <b>Title</b></a>
        <span class="result__snippet">A snippet</span>
        '''
        results = _parse_ddg_results(html, 10)
        assert len(results) == 1
        assert results[0]["title"] == "Example Title"
        assert "snippet" in results[0]["snippet"].lower()

    def test_respects_max_results(self):
        html = '''
        <a class="result__a" href="https://a.com">A</a>
        <span class="result__snippet">S1</span>
        <a class="result__a" href="https://b.com">B</a>
        <span class="result__snippet">S2</span>
        <a class="result__a" href="https://c.com">C</a>
        <span class="result__snippet">S3</span>
        '''
        results = _parse_ddg_results(html, 2)
        assert len(results) == 2

    def test_uddg_redirect(self):
        html = '''
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.site.com%2Fpage&rut=abc">Title</a>
        <span class="result__snippet">Snippet</span>
        '''
        results = _parse_ddg_results(html, 10)
        assert len(results) == 1
        assert results[0]["url"] == "https://real.site.com/page"

    def test_empty_html(self):
        assert _parse_ddg_results("", 10) == []

    def test_strips_html_from_title(self):
        html = '''
        <a class="result__a" href="https://x.com"><b>Bold</b> Title</a>
        <span class="result__snippet">Snip</span>
        '''
        results = _parse_ddg_results(html, 10)
        assert results[0]["title"] == "Bold Title"
