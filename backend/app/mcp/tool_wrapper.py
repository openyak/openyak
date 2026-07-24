"""MCP tool wrapper — adapts an MCP tool to the OpenYak ToolDefinition interface."""

from __future__ import annotations

import logging
from typing import Any, TYPE_CHECKING

from app.evidence.source_evidence import (
    SourceEvidence,
    SourceRecord,
    build_source_record,
    extract_source_evidence,
    merge_source_evidence,
)
from app.tool.base import ToolDefinition, ToolResult

if TYPE_CHECKING:
    from app.mcp.client import McpClient
    from app.tool.context import ToolContext
    from mcp.types import Tool as McpTool

logger = logging.getLogger(__name__)

_MAX_MCP_CONTENT_ITEMS = 512
_MAX_MCP_SOURCE_RECORDS = 200
_MAX_MCP_EVIDENCE_TEXT_BYTES = 4 * 1024 * 1024


class McpToolWrapper(ToolDefinition):
    """Wraps an MCP server tool as an OpenYak ToolDefinition.

    Tool ID: ``{server_name}_{tool_name}`` (sanitised).
    """

    def __init__(self, client: "McpClient", mcp_tool: "McpTool") -> None:
        self._client = client
        self._mcp_tool = mcp_tool
        self._tool_id = client.tool_id(mcp_tool.name)

    @property
    def id(self) -> str:
        return self._tool_id

    @property
    def description(self) -> str:
        desc = self._mcp_tool.description or f"MCP tool from {self._client.name}"
        return f"[MCP: {self._client.name}] {desc}"

    @property
    def is_concurrency_safe(self) -> bool:
        """Trust only the MCP protocol's explicit read-only annotation."""
        annotations = getattr(self._mcp_tool, "annotations", None)
        if isinstance(annotations, dict):
            return annotations.get("readOnlyHint") is True
        return bool(
            annotations is not None
            and getattr(annotations, "readOnlyHint", False) is True
        )

    def parameters_schema(self) -> dict[str, Any]:
        schema = self._mcp_tool.inputSchema
        if isinstance(schema, dict):
            # Ensure it has type: object for OpenAI function calling
            result = dict(schema)
            result.setdefault("type", "object")
            result.setdefault("properties", {})
            return result
        return {"type": "object", "properties": {}}

    async def execute(self, args: dict[str, Any], ctx: "ToolContext") -> ToolResult:
        try:
            result = await self._client.call_tool(self._mcp_tool.name, args)
        except Exception as e:
            return ToolResult(error=f"MCP tool call failed: {e}")

        # Convert MCP result content to ToolResult
        text_parts: list[str] = []
        attachments: list[dict[str, Any]] = []
        metadata: dict[str, Any] = {}
        sources: dict[str, SourceRecord] = {}
        evidence_truncated = False
        evidence_incomplete = False
        evidence_covered = False
        evidence_text_bytes_remaining = _MAX_MCP_EVIDENCE_TEXT_BYTES

        def mark_incomplete() -> None:
            nonlocal evidence_truncated, evidence_incomplete
            evidence_truncated = True
            evidence_incomplete = True

        def add_record(record: SourceRecord | None) -> None:
            if record is None:
                return
            current = sources.get(record["url"])
            if current is None:
                if len(sources) >= _MAX_MCP_SOURCE_RECORDS:
                    mark_incomplete()
                    return
                sources[record["url"]] = record
                return
            if (
                current["title"] == current["domain"]
                and record["title"] != record["domain"]
            ):
                current["title"] = record["title"]
            if (
                current["snippet"] is None
                and record["snippet"] is not None
            ):
                current["snippet"] = record["snippet"]

        def add_evidence(evidence: SourceEvidence) -> None:
            nonlocal evidence_truncated, evidence_incomplete, evidence_covered
            evidence_truncated = (
                evidence_truncated or evidence.truncated
            )
            evidence_incomplete = (
                evidence_incomplete or evidence.incomplete
            )
            evidence_covered = evidence_covered or evidence.covered
            for record in evidence.items:
                add_record(record)

        def add_text_evidence(value: Any) -> None:
            nonlocal evidence_text_bytes_remaining
            if not isinstance(value, str):
                return
            raw = value.strip()
            if not raw or raw[0] not in "[{":
                return
            if len(raw) > evidence_text_bytes_remaining:
                mark_incomplete()
                return
            byte_size = len(raw.encode("utf-8"))
            if byte_size > evidence_text_bytes_remaining:
                mark_incomplete()
                return
            evidence_text_bytes_remaining -= byte_size
            add_evidence(extract_source_evidence(raw))

        for index, item in enumerate(result.content):
            inspect_evidence = index < _MAX_MCP_CONTENT_ITEMS
            if index == _MAX_MCP_CONTENT_ITEMS:
                mark_incomplete()
            if item.type == "text":
                text_parts.append(item.text)
                if inspect_evidence:
                    add_text_evidence(item.text)
            elif item.type == "image":
                attachments.append({
                    "type": "file",
                    "mime_type": getattr(item, "mimeType", "image/png"),
                    "url": f"data:{getattr(item, 'mimeType', 'image/png')};base64,{item.data}",
                })
            elif item.type == "resource_link":
                if inspect_evidence:
                    evidence_covered = True
                    record = build_source_record(
                        url=str(getattr(item, "uri", "")),
                        title=(
                            getattr(item, "title", None)
                            or getattr(item, "name", None)
                        ),
                        snippet=getattr(item, "description", None),
                    )
                    add_record(record)
            elif item.type == "resource":
                resource = item.resource
                if inspect_evidence:
                    evidence_covered = True
                    record = build_source_record(
                        url=str(getattr(resource, "uri", "")),
                    )
                    add_record(record)
                if hasattr(resource, "text") and resource.text:
                    text_parts.append(resource.text)
                    if inspect_evidence:
                        add_text_evidence(resource.text)
                elif hasattr(resource, "blob") and resource.blob:
                    attachments.append({
                        "type": "file",
                        "mime_type": getattr(
                            resource,
                            "mimeType",
                            "application/octet-stream",
                        ),
                        "url": (
                            "data:"
                            f"{getattr(resource, 'mimeType', 'application/octet-stream')}"
                            f";base64,{resource.blob}"
                        ),
                    })

        output = "\n".join(text_parts)

        if result.isError:
            return ToolResult(error=output or "MCP tool returned an error")

        structured_content = getattr(result, "structuredContent", None)
        if structured_content is None:
            structured_content = getattr(
                result,
                "structured_content",
                None,
            )
        add_evidence(extract_source_evidence(structured_content))
        merge_source_evidence(
            metadata,
            SourceEvidence(
                items=list(sources.values()),
                truncated=evidence_truncated,
                incomplete=evidence_incomplete,
                covered=evidence_covered,
            ),
        )

        return ToolResult(
            output=output,
            title=f"{self._client.name}/{self._mcp_tool.name}",
            attachments=attachments,
            metadata=metadata,
        )
