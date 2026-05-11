"""Tests for app.tool.builtin.web_search — result parsing and formatting."""

from __future__ import annotations

from app.tool.builtin.web_search import WebSearchTool, _parse_ddg_results


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


class TestFormatSerperResults:
    def test_organic_results(self):
        data = {"organic": [
            {"title": "Result 1", "link": "https://a.com", "snippet": "Snip 1"},
            {"title": "Result 2", "link": "https://b.com", "snippet": "Snip 2"},
        ]}
        usage = {"hosted_search_used": True, "daily_searches_used": 5, "daily_search_limit": 100}
        result = WebSearchTool._format_serper_results("test", 10, data, usage)
        assert result.success
        assert "Result 1" in result.output
        assert "Result 2" in result.output
        assert result.metadata["count"] == 2

    def test_knowledge_graph(self):
        data = {
            "knowledgeGraph": {"title": "Python", "type": "Language", "description": "A programming language"},
            "organic": [{"title": "R1", "link": "https://a.com", "snippet": "S1"}],
        }
        usage = {}
        result = WebSearchTool._format_serper_results("test", 10, data, usage)
        assert "[Knowledge Graph] Python" in result.output

    def test_no_results(self):
        data = {"organic": []}
        usage = {"hosted_search_used": False, "daily_searches_used": 0, "daily_search_limit": 100}
        result = WebSearchTool._format_serper_results("test", 10, data, usage)
        assert result.output == "No results found."
        assert "hosted_search_used" in result.metadata

    def test_hosted_search_usage_meta(self):
        data = {"organic": [{"title": "R1", "link": "https://a.com", "snippet": "S1"}]}
        usage = {"hosted_search_used": True, "daily_searches_used": 10, "daily_search_limit": 50}
        result = WebSearchTool._format_serper_results("test", 10, data, usage)
        assert result.metadata["hosted_search_used"] is True
        assert result.metadata["daily_searches_used"] == 10

    def test_respects_max_results_cap(self):
        data = {"organic": [
            {"title": f"R{i}", "link": f"https://{i}.com", "snippet": f"S{i}"}
            for i in range(20)
        ]}
        usage = {}
        result = WebSearchTool._format_serper_results("test", 3, data, usage)
        assert result.metadata["count"] == 3
