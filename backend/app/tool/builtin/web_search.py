"""Web search tool — search via OpenYak Proxy (Serper/Google) or DuckDuckGo fallback.

When proxy mode is active, searches go through the deployed proxy which
holds the Serper API key and handles hosted-search limits. Without proxy, falls
back to free DuckDuckGo HTML scraping.
"""

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

        from app.config import get_settings
        settings = get_settings()

        if settings.proxy_url and settings.proxy_token:
            return await self._search_proxy(
                query, max_results,
                settings.proxy_url, settings.proxy_token,
            )
        return await self._search_ddg(query, max_results)

    # ------------------------------------------------------------------ #
    # Proxy search (Serper via deployed proxy)
    # ------------------------------------------------------------------ #

    async def _search_proxy(
        self, query: str, max_results: int,
        proxy_url: str, proxy_token: str,
    ) -> ToolResult:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    f"{proxy_url.rstrip('/')}/api/search",
                    json={"q": query, "num": max_results},
                    headers={"Authorization": f"Bearer {proxy_token}"},
                )

            if resp.status_code == 429:
                return ToolResult(error="Daily search limit reached")
            if resp.status_code == 402:
                return ToolResult(error="Hosted web search is unavailable")
            if resp.status_code != 200:
                return ToolResult(error=f"Search failed: HTTP {resp.status_code}")

            data = resp.json()
            serper_data = data.get("results", {})
            proxy_usage = data.get("usage", {})

            # Store hosted-search usage info in metadata for processor to read.
            usage_meta = {
                "hosted_search_used": proxy_usage.get("charged", False),
                "daily_searches_used": proxy_usage.get("daily_searches_used", 0),
                "daily_search_limit": proxy_usage.get("daily_search_limit", 0),
            }

            return self._format_serper_results(query, max_results, serper_data, usage_meta)

        except Exception as e:
            return ToolResult(error=f"Search failed: {e}")

    @staticmethod
    def _format_serper_results(
        query: str, max_results: int,
        data: dict[str, Any], usage_meta: dict[str, Any],
    ) -> ToolResult:
        output_lines: list[str] = []
        results_data: list[dict[str, str]] = []

        # Knowledge Graph
        kg = data.get("knowledgeGraph")
        if kg:
            title = kg.get("title", "")
            kg_type = kg.get("type", "")
            desc = kg.get("description", "")
            output_lines.append(f"[Knowledge Graph] {title}")
            if kg_type:
                output_lines.append(f"   Type: {kg_type}")
            if desc:
                output_lines.append(f"   {desc}")
            attrs = kg.get("attributes", {})
            for k, v in list(attrs.items())[:5]:
                output_lines.append(f"   {k}: {v}")
            output_lines.append("")

        # Organic results
        organic = data.get("organic", [])
        for i, r in enumerate(organic[:max_results], 1):
            title = r.get("title", "")
            url = r.get("link", "")
            snippet = r.get("snippet", "")
            output_lines.append(f"{i}. {title}")
            output_lines.append(f"   {url}")
            if snippet:
                output_lines.append(f"   {snippet}")
            output_lines.append("")
            results_data.append({"url": url, "title": title, "snippet": snippet})

        if not organic:
            return ToolResult(
                output="No results found.",
                title=f"Search: {query[:50]}",
                metadata=usage_meta,
            )

        count = min(len(organic), max_results)
        return ToolResult(
            output="\n".join(output_lines),
            title=f"Search: {query[:50]} ({count} results)",
            metadata={
                "query": query,
                "count": count,
                "results": results_data,
                **usage_meta,
            },
        )

    # ------------------------------------------------------------------ #
    # DuckDuckGo fallback (no API key needed)
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
