"""Tests for app.mcp.tool_wrapper — MCP tool schema normalization."""

from __future__ import annotations

import json
import time

import pytest

pytest.importorskip("mcp")

from types import SimpleNamespace
from unittest.mock import AsyncMock

from mcp.types import (
    CallToolResult,
    EmbeddedResource,
    ResourceLink,
    TextContent,
    TextResourceContents,
)

import app.mcp.tool_wrapper as tool_wrapper_module
from app.mcp.tool_wrapper import McpToolWrapper


def _make_wrapper(input_schema: dict | None = None, description: str = "A tool") -> McpToolWrapper:
    client = SimpleNamespace(name="slack", tool_id=lambda name: f"slack_{name}")
    mcp_tool = SimpleNamespace(
        name="send_message",
        description=description,
        inputSchema=input_schema or {"type": "object", "properties": {"text": {"type": "string"}}},
    )
    return McpToolWrapper(client, mcp_tool)


class TestMcpToolWrapperSchema:
    def test_ensures_type_object(self):
        wrapper = _make_wrapper({"properties": {"x": {"type": "string"}}})
        schema = wrapper.parameters_schema()
        assert schema["type"] == "object"

    def test_ensures_properties_dict(self):
        wrapper = _make_wrapper({"type": "object"})
        schema = wrapper.parameters_schema()
        assert schema["properties"] == {}

    def test_passthrough_valid_schema(self):
        original = {"type": "object", "properties": {"x": {"type": "string"}}, "required": ["x"]}
        wrapper = _make_wrapper(original)
        schema = wrapper.parameters_schema()
        assert schema["required"] == ["x"]
        assert "x" in schema["properties"]


class TestMcpToolWrapperDescription:
    def test_prefixes_server_name(self):
        wrapper = _make_wrapper(description="Send a message")
        assert wrapper.description.startswith("[MCP: slack]")
        assert "Send a message" in wrapper.description


@pytest.mark.asyncio
async def test_extracts_protocol_structured_content_and_resource_uris():
    result = CallToolResult(
        content=[
            ResourceLink(
                type="resource_link",
                uri="https://mcp.example/link#details",
                name="linked",
                title="Linked source",
                description="Resource link description.",
            ),
            EmbeddedResource(
                type="resource",
                resource=TextResourceContents(
                    uri="https://mcp.example/embedded#section",
                    text=(
                        '{"pageUrl":"https://mcp.example/embedded-text",'
                        '"title":"Embedded text source"}'
                    ),
                ),
            ),
            ResourceLink(
                type="resource_link",
                uri=(
                    "https://mcp.example/private"
                    "?token=must-not-be-persisted"
                ),
                name="private",
            ),
        ],
        structuredContent={
            "items": [
                {
                    "externalUrl": "https://mcp.example/structured",
                    "title": "Structured source",
                }
            ],
            "secret_payload": "must-not-be-persisted",
        },
    )
    client = SimpleNamespace(
        name="slack",
        tool_id=lambda name: f"slack_{name}",
        call_tool=AsyncMock(return_value=result),
    )
    wrapper = McpToolWrapper(
        client,
        SimpleNamespace(
            name="search",
            description="Search",
            inputSchema={"type": "object", "properties": {}},
        ),
    )

    tool_result = await wrapper.execute({}, SimpleNamespace())

    envelope = tool_result.metadata["source_evidence"]
    assert {item["url"] for item in envelope["items"]} == {
        "https://mcp.example/link",
        "https://mcp.example/embedded",
        "https://mcp.example/embedded-text",
        "https://mcp.example/structured",
    }
    assert "must-not-be-persisted" not in str(tool_result.metadata)


@pytest.mark.asyncio
async def test_aggregates_200_resource_links_once_with_bounded_metadata():
    result = CallToolResult(
        content=[
            ResourceLink(
                type="resource_link",
                uri=f"https://mcp.example/source/{index}",
                name=f"source-{index}",
                title=f"Source {index}",
            )
            for index in range(200)
        ],
    )
    client = SimpleNamespace(
        name="research",
        tool_id=lambda name: f"research_{name}",
        call_tool=AsyncMock(return_value=result),
    )
    wrapper = McpToolWrapper(
        client,
        SimpleNamespace(
            name="search",
            description="Search",
            inputSchema={"type": "object", "properties": {}},
        ),
    )

    started = time.perf_counter()
    tool_result = await wrapper.execute({}, SimpleNamespace())
    elapsed = time.perf_counter() - started

    envelope = tool_result.metadata["source_evidence"]
    assert len(envelope["items"]) == 200
    assert envelope.get("truncated") is not True
    assert envelope.get("incomplete") is not True
    assert elapsed < 2
    assert len(
        json.dumps(
            tool_result.metadata,
            separators=(",", ":"),
        ).encode("utf-8")
    ) <= 64 * 1024


@pytest.mark.asyncio
async def test_oversized_text_result_keeps_empty_incomplete_coverage():
    raw = '{"padding":"' + ("x" * (2 * 1024 * 1024)) + '"}'
    result = CallToolResult(
        content=[
            TextContent(
                type="text",
                text=raw,
            )
        ],
    )
    client = SimpleNamespace(
        name="research",
        tool_id=lambda name: f"research_{name}",
        call_tool=AsyncMock(return_value=result),
    )
    wrapper = McpToolWrapper(
        client,
        SimpleNamespace(
            name="search",
            description="Search",
            inputSchema={"type": "object", "properties": {}},
        ),
    )

    tool_result = await wrapper.execute({}, SimpleNamespace())

    assert tool_result.output == raw
    assert tool_result.metadata["source_evidence"] == {
        "schema_version": 1,
        "items": [],
        "truncated": True,
        "incomplete": True,
    }
    assert "x" * 100 not in str(tool_result.metadata)


@pytest.mark.asyncio
async def test_unsafe_resource_link_keeps_empty_authoritative_coverage():
    result = CallToolResult(
        content=[
            ResourceLink(
                type="resource_link",
                uri=(
                    "https://mcp.example/private"
                    "?client_secret=must-not-be-persisted"
                ),
                name="private",
                title="Private resource",
            ),
        ],
    )
    client = SimpleNamespace(
        name="research",
        tool_id=lambda name: f"research_{name}",
        call_tool=AsyncMock(return_value=result),
    )
    wrapper = McpToolWrapper(
        client,
        SimpleNamespace(
            name="search",
            description="Search",
            inputSchema={"type": "object", "properties": {}},
        ),
    )

    tool_result = await wrapper.execute({}, SimpleNamespace())

    assert tool_result.metadata["source_evidence"] == {
        "schema_version": 1,
        "items": [],
    }
    assert "must-not-be-persisted" not in str(tool_result.metadata)


@pytest.mark.asyncio
async def test_plain_text_result_does_not_claim_structured_coverage():
    result = CallToolResult(
        content=[
            TextContent(
                type="text",
                text="Ordinary response with no structured evidence.",
            )
        ],
    )
    client = SimpleNamespace(
        name="research",
        tool_id=lambda name: f"research_{name}",
        call_tool=AsyncMock(return_value=result),
    )
    wrapper = McpToolWrapper(
        client,
        SimpleNamespace(
            name="search",
            description="Search",
            inputSchema={"type": "object", "properties": {}},
        ),
    )

    tool_result = await wrapper.execute({}, SimpleNamespace())

    assert "source_evidence" not in tool_result.metadata


@pytest.mark.asyncio
async def test_content_limit_preserves_text_attachments_and_marks_incomplete():
    content = [
        TextContent(type="text", text=f"part-{index}")
        for index in range(513)
    ]
    content.append(
        SimpleNamespace(
            type="image",
            data="YWJj",
            mimeType="image/png",
        )
    )
    result = SimpleNamespace(
        content=content,
        isError=False,
        structuredContent=None,
    )
    client = SimpleNamespace(
        name="research",
        tool_id=lambda name: f"research_{name}",
        call_tool=AsyncMock(return_value=result),
    )
    wrapper = McpToolWrapper(
        client,
        SimpleNamespace(
            name="search",
            description="Search",
            inputSchema={"type": "object", "properties": {}},
        ),
    )

    tool_result = await wrapper.execute({}, SimpleNamespace())

    assert tool_result.output.splitlines() == [
        f"part-{index}" for index in range(513)
    ]
    assert tool_result.attachments == [
        {
            "type": "file",
            "mime_type": "image/png",
            "url": "data:image/png;base64,YWJj",
        }
    ]
    assert tool_result.metadata["source_evidence"] == {
        "schema_version": 1,
        "items": [],
        "truncated": True,
        "incomplete": True,
    }


@pytest.mark.asyncio
async def test_text_evidence_byte_budget_preserves_output_and_skips_overflow(
    monkeypatch,
):
    first = json.dumps(
        {"url": "https://mcp.example/within-budget"},
        separators=(",", ":"),
    )
    second = json.dumps(
        {"url": "https://mcp.example/over-budget"},
        separators=(",", ":"),
    )
    monkeypatch.setattr(
        tool_wrapper_module,
        "_MAX_MCP_EVIDENCE_TEXT_BYTES",
        len(first.encode("utf-8")) + len(second.encode("utf-8")) - 1,
    )
    result = CallToolResult(
        content=[
            TextContent(type="text", text=first),
            TextContent(type="text", text=second),
        ],
    )
    client = SimpleNamespace(
        name="research",
        tool_id=lambda name: f"research_{name}",
        call_tool=AsyncMock(return_value=result),
    )
    wrapper = McpToolWrapper(
        client,
        SimpleNamespace(
            name="search",
            description="Search",
            inputSchema={"type": "object", "properties": {}},
        ),
    )

    tool_result = await wrapper.execute({}, SimpleNamespace())

    assert tool_result.output == f"{first}\n{second}"
    envelope = tool_result.metadata["source_evidence"]
    assert envelope["items"] == [
        {
            "url": "https://mcp.example/within-budget",
            "title": "mcp.example",
        }
    ]
    assert envelope["truncated"] is True
    assert envelope["incomplete"] is True
