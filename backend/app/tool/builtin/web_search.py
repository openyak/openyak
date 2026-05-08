"""Web search tool — DuckDuckGo HTML scraping (no API key required)."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote_plus

import httpx

from app.tool.base import ToolDefinition, ToolResult
from app.tool.context import ToolContext


class WebSearchTool(ToolDefinition):

    @property
    def id(self) -> str:
        return "web_search"

    @property
    def is_concurrency_safe(self) -> bool:
        return True

    @property
    def description(self) -> str:
        return (
            "Search the web for information. Returns search results with titles and URLs. "
            "For time-sensitive queries, include the current year in the search query "
            "to get recent results."
        )

    def parameters_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of results (default: 10)",
                    "default": 10,
                },
            },
            "required": ["query"],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        query = args["query"]
        max_results = args.get("max_results", 10)
        return await self._search_ddg(query, max_results)

    # ------------------------------------------------------------------ #
    # DuckDuckGo HTML scraping (no API key needed)
    # ------------------------------------------------------------------ #

    async def _search_ddg(self, query: str, max_results: int) -> ToolResult:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.get(
                    f"https://html.duckduckgo.com/html/?q={quote_plus(query)}",
                    headers={"User-Agent": "OpenYak/0.1"},
                )
                resp.raise_for_status()

            results = _parse_ddg_results(resp.text, max_results)

            if not results:
                return ToolResult(
                    output="No results found.",
                    title=f"Search: {query[:50]}",
                )

            output_lines = []
            results_data = []
            for i, r in enumerate(results, 1):
                output_lines.append(f"{i}. {r['title']}")
                output_lines.append(f"   {r['url']}")
                if r.get("snippet"):
                    output_lines.append(f"   {r['snippet']}")
                output_lines.append("")
                results_data.append({"url": r["url"], "title": r["title"], "snippet": r.get("snippet", "")})

            return ToolResult(
                output="\n".join(output_lines),
                title=f"Search: {query[:50]} ({len(results)} results)",
                metadata={"query": query, "count": len(results), "results": results_data},
            )

        except Exception as e:
            return ToolResult(error=f"Search failed: {e}")


def _parse_ddg_results(html: str, max_results: int) -> list[dict[str, str]]:
    """Parse DuckDuckGo HTML search results."""
    results = []

    link_pattern = re.compile(
        r'class="result__a"[^>]*href="([^"]*)"[^>]*>(.+?)</a>', re.DOTALL
    )
    snippet_pattern = re.compile(
        r'class="result__snippet"[^>]*>(.+?)</(?:a|span|div)', re.DOTALL
    )

    links = link_pattern.findall(html)
    snippets = snippet_pattern.findall(html)

    for i, (url, title) in enumerate(links[:max_results]):
        title = re.sub(r"<[^>]+>", "", title).strip()
        snippet = ""
        if i < len(snippets):
            snippet = re.sub(r"<[^>]+>", "", snippets[i]).strip()

        if "uddg=" in url:
            from urllib.parse import parse_qs, urlparse
            parsed = urlparse(url)
            qs = parse_qs(parsed.query)
            if "uddg" in qs:
                url = qs["uddg"][0]

        results.append({"url": url, "title": title, "snippet": snippet})

    return results
