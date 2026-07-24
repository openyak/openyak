"""Tests for bounded, safe structured source evidence."""

from __future__ import annotations

import json
import time
from types import SimpleNamespace

import pytest

from app.evidence.source_evidence import (
    SOURCE_EVIDENCE_METADATA_KEY,
    SourceEvidence,
    build_source_record,
    extract_source_evidence,
    merge_source_evidence,
)
from app.tool.base import ToolDefinition, ToolResult


def test_compact_metadata_stays_below_64_kib_and_drops_secrets():
    structured = {
        "items": [
            {
                "documentUrl": (
                    f"https://docs.example/{index}/"
                    f"{'p' * 180}?view=summary"
                ),
                "title": f"Document {index} {'t' * 210}",
                "description": f"Snippet {index} {'s' * 570}",
                "padding": "must-not-be-persisted",
            }
            for index in range(250)
        ]
        + [
            {
                "sourceUrl": (
                    "https://docs.example/private"
                    "?x-amz-signature=must-not-be-persisted"
                ),
                "title": "Signed URL",
            },
            {
                "callbackUrl": "https://docs.example/callback",
                "title": "Callback URL",
            },
        ]
    }

    evidence = extract_source_evidence(structured)
    metadata = {"truncated": True, "output_path": "/tmp/output.txt"}
    merge_source_evidence(metadata, evidence)

    encoded = json.dumps(
        metadata,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    envelope = metadata[SOURCE_EVIDENCE_METADATA_KEY]
    assert len(encoded) <= 64 * 1024
    assert envelope["schema_version"] == 1
    assert envelope["truncated"] is True
    assert 0 < len(envelope["items"]) < 200
    assert b"must-not-be-persisted" not in encoded
    assert b"callback" not in encoded


@pytest.mark.asyncio
async def test_generic_tool_definition_does_not_extract_source_evidence(
    tmp_path,
):
    raw_output = json.dumps(
        {
            "padding": "raw-secret-padding-" * 4000,
            "items": [
                {
                    "pageUrl": "https://tool.example/source#section",
                    "title": "Tool source",
                }
            ],
        }
    )

    class LargeJsonTool(ToolDefinition):
        @property
        def id(self):
            return "connector_search"

        @property
        def description(self):
            return "Return structured connector data"

        def parameters_schema(self):
            return {"type": "object", "properties": {}}

        async def execute(self, args, ctx):
            return ToolResult(output=raw_output)

    result = await LargeJsonTool()(
        {},
        SimpleNamespace(
            workspace=str(tmp_path),
            agent=SimpleNamespace(tools=[]),
        ),
    )

    assert result.metadata["truncated"] is True
    assert "https://tool.example/source" not in result.output
    encoded = json.dumps(result.metadata).encode("utf-8")
    assert b"raw-secret-padding" not in encoded
    assert len(encoded) <= 64 * 1024
    assert SOURCE_EVIDENCE_METADATA_KEY not in result.metadata


def test_rejects_secret_aliases_paths_and_sensitive_labels():
    evidence = extract_source_evidence(
        {
            "items": [
                {
                    "url": f"https://safe.example/query?{key}=private",
                    "title": "Must be rejected",
                }
                for key in (
                    "key",
                    "code",
                    "refresh_token",
                    "authToken",
                    "AWSAccessKeyId",
                    "oauth_token",
                    "access_token",
                    "auth_token",
                    "id_token",
                    "sessionToken",
                    "secretKey",
                )
            ]
            + [
                {
                    "url": "https://safe.example/token/private",
                    "title": "Sensitive path",
                },
                {
                    "url": "https://safe.example/reset-password/private",
                    "title": "Sensitive path",
                },
                {
                    "url": "https://safe.example/access_token/private",
                    "title": "Sensitive path",
                },
                {
                    "url": "https://safe.example/credentials/private",
                    "title": "Sensitive path",
                },
                {
                    "url": "https://safe.example/docs/reset-password",
                    "title": "Public reset documentation",
                },
                {
                    "url": "https://safe.example/docs/token-economy",
                    "title": "Token economy",
                },
                {
                    "url": "https://safe.example/oauth/token",
                    "title": "OAuth token endpoint",
                },
                {
                    "url": "https://safe.example/redacted-title",
                    "title": "Authorization: Bearer private-value",
                    "description": "Public description.",
                },
                {
                    "url": "https://safe.example/redacted-snippet",
                    "title": "Public title",
                    "description": "password=private-value",
                },
                {
                    "url": "https://safe.example/public",
                    "title": "Public title",
                    "description": "Public description.",
                },
            ],
        }
    )

    assert [item["url"] for item in evidence.items] == [
        "https://safe.example/docs/reset-password",
        "https://safe.example/docs/token-economy",
        "https://safe.example/oauth/token",
        "https://safe.example/redacted-title",
        "https://safe.example/redacted-snippet",
        "https://safe.example/public",
    ]
    assert evidence.items[3]["title"] == "safe.example"
    assert evidence.items[3]["snippet"] == "Public description."
    assert evidence.items[4]["title"] == "Public title"
    assert evidence.items[4]["snippet"] is None
    assert "private-value" not in json.dumps(evidence.items)

    for sensitive_text in (
        "api_key=private-value",
        "clientSecret: private-value",
        "access_key=private-value",
        "credential: private-value",
        "refresh_token=private-value",
        "access_token=private-value",
        "auth_token: private-value",
        "idToken=private-value",
        "sessionToken: private-value",
        "secretKey=private-value",
        "oauth_token: private-value",
    ):
        record = build_source_record(
            url="https://safe.example/selected-text",
            title=sensitive_text,
            snippet=sensitive_text,
        )
        assert record is not None
        assert record["title"] == "safe.example"
        assert record["snippet"] is None

    benign = build_source_record(
        url="https://safe.example/benign-language",
        title="Token economy: 2026 outlook",
        snippet="Credential management: overview.",
    )
    assert benign is not None
    assert benign["title"] == "Token economy: 2026 outlook"
    assert benign["snippet"] == "Credential management: overview."


def test_flat_container_walks_are_bounded():
    scalar_list = [0] * 1_000_000
    started = time.perf_counter()
    list_evidence = extract_source_evidence(scalar_list)
    list_elapsed = time.perf_counter() - started

    flat_dict = {f"field_{index}": index for index in range(300_000)}
    started = time.perf_counter()
    dict_evidence = extract_source_evidence(flat_dict)
    dict_elapsed = time.perf_counter() - started

    assert list_evidence.items == []
    assert list_evidence.truncated is True
    assert list_evidence.incomplete is True
    assert dict_evidence.items == []
    assert dict_evidence.truncated is True
    assert dict_evidence.incomplete is True
    assert list_elapsed < 2
    assert dict_elapsed < 2


def test_merge_rebuilds_invalid_envelopes_with_full_metadata_budget():
    safe_record = build_source_record(
        url="https://budget.example/reference",
        title="Budget reference",
        snippet="Compact evidence.",
    )
    assert safe_record is not None
    metadata = {
        "other": "o" * (10 * 1024),
        SOURCE_EVIDENCE_METADATA_KEY: {
            "schema_version": 999,
            "items": [
                {
                    "url": "https://unsafe.example/?token=private",
                    "title": "Authorization private",
                }
            ],
            "padding": "private-padding-" * 10_000,
        },
    }

    merge_source_evidence(
        metadata,
        SourceEvidence(items=[safe_record]),
    )

    encoded = json.dumps(
        metadata,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    assert len(encoded) <= 64 * 1024
    assert b"private-padding" not in encoded
    assert b"unsafe.example" not in encoded
    assert metadata[SOURCE_EVIDENCE_METADATA_KEY]["items"] == [
        {
            "url": "https://budget.example/reference",
            "title": "Budget reference",
            "snippet": "Compact evidence.",
        }
    ]

    invalid_only = {
        SOURCE_EVIDENCE_METADATA_KEY: "not-an-envelope",
    }
    merge_source_evidence(invalid_only, [])
    assert SOURCE_EVIDENCE_METADATA_KEY not in invalid_only


def test_oversized_json_persists_empty_incomplete_coverage():
    raw = '{"padding":"' + ("x" * (2 * 1024 * 1024)) + '"}'

    evidence = extract_source_evidence(raw)
    metadata: dict = {}
    merge_source_evidence(metadata, evidence)

    assert evidence.items == []
    assert evidence.truncated is True
    assert evidence.incomplete is True
    assert evidence.covered is True
    assert metadata[SOURCE_EVIDENCE_METADATA_KEY] == {
        "schema_version": 1,
        "items": [],
        "truncated": True,
        "incomplete": True,
    }


def test_unsafe_only_json_is_authoritative_but_plain_text_is_not():
    unsafe_json = json.dumps(
        {
            "items": [
                {
                    "url": "https://private.example/?refresh_token=private",
                    "title": "Private",
                },
                {
                    "url": "file:///private/source.txt",
                    "title": "Local",
                },
            ]
        }
    )

    unsafe_evidence = extract_source_evidence(unsafe_json)
    unsafe_metadata: dict = {}
    merge_source_evidence(unsafe_metadata, unsafe_evidence)

    assert unsafe_evidence.items == []
    assert unsafe_evidence.covered is True
    assert unsafe_metadata[SOURCE_EVIDENCE_METADATA_KEY] == {
        "schema_version": 1,
        "items": [],
    }

    plain_evidence = extract_source_evidence(
        "Ordinary text mentions https://example.com/source"
    )
    plain_metadata: dict = {}
    merge_source_evidence(plain_metadata, plain_evidence)

    assert plain_evidence.items == []
    assert plain_evidence.covered is False
    assert SOURCE_EVIDENCE_METADATA_KEY not in plain_metadata
