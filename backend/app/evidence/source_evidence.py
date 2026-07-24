"""Bounded extraction of safe web-source evidence from structured tool data."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Iterable, TypedDict
from urllib.parse import parse_qsl, unquote, urlsplit, urlunsplit

SOURCE_EVIDENCE_METADATA_KEY = "source_evidence"
SOURCE_EVIDENCE_SCHEMA_VERSION = 1

_TITLE_LIMIT = 240
_SNIPPET_LIMIT = 600
_URL_LIMIT = 4096
_JSON_BYTES_LIMIT = 2 * 1024 * 1024
_NESTED_JSON_BYTES_LIMIT = 64 * 1024
_NESTED_JSON_TOTAL_BYTES_LIMIT = 256 * 1024
# Leave headroom for the ToolPart's normal title/truncation/path metadata while
# keeping the complete persisted metadata comfortably below 64 KiB.
_METADATA_BYTES_LIMIT = 60 * 1024
_DEPTH_LIMIT = 12
_NODE_LIMIT = 2000
_SOURCE_LIMIT = 200

_URL_KEYS = frozenset(
    {
        "url",
        "uri",
        "href",
        "link",
        "permalink",
        "weburl",
        "sourceurl",
        "canonicalurl",
        "documenturl",
        "externalurl",
        "pageurl",
    }
)
_SENSITIVE_QUERY_KEYS = frozenset(
    {
        "accesskey",
        "accesstoken",
        "apikey",
        "authtoken",
        "auth",
        "authorization",
        "awsaccesskeyid",
        "clientsecret",
        "code",
        "credential",
        "idtoken",
        "key",
        "oauthtoken",
        "password",
        "refreshtoken",
        "secret",
        "secretkey",
        "sessiontoken",
        "sig",
        "signature",
        "token",
        "xamzcredential",
        "xamzsecuritytoken",
        "xamzsignature",
        "xgoogcredential",
        "xgoogsignature",
        "xmscredential",
        "xmssignature",
    }
)
_SENSITIVE_PATH_SEGMENTS = frozenset(
    {
        "accesskey",
        "accesstoken",
        "apikey",
        "auth",
        "authtoken",
        "authorization",
        "awsaccesskeyid",
        "clientsecret",
        "credential",
        "credentials",
        "idtoken",
        "key",
        "oauthtoken",
        "password",
        "refreshtoken",
        "resetpassword",
        "secret",
        "secretkey",
        "secrets",
        "sessiontoken",
        "token",
        "tokens",
    }
)
_SENSITIVE_TEXT = re.compile(
    r"""(?ix)
    (?:
        \bauthorization\b\s+bearer\b
        |
        \bbearer\s+[a-z0-9._~+/=-]{4,}
        |
        (?<![a-z0-9])
        (?:
            authorization
            |password
            |passwd
            |token
            |secret
            |api[_\s-]?key
            |client[_\s-]?secret
            |access[_\s-]?key
            |access[_\s-]?token
            |auth[_\s-]?token
            |id[_\s-]?token
            |session[_\s-]?token
            |refresh[_\s-]?token
            |oauth[_\s-]?token
            |secret[_\s-]?key
            |credential
            |aws[_\s-]?access[_\s-]?key[_\s-]?id
        )
        \s*[:=]
    )
    """
)
_SENSITIVE_IDENTIFIER_PARTS = (
    "accesskey",
    "apikey",
    "authorization",
    "credential",
    "password",
    "secret",
    "token",
)


class SourceRecord(TypedDict):
    url: str
    title: str
    domain: str
    snippet: str | None


@dataclass(frozen=True)
class SourceEvidence:
    items: list[SourceRecord]
    truncated: bool = False
    incomplete: bool = False
    covered: bool = False


def _clean_text(value: Any, *, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    text = re.sub(r"\s+", " ", value).strip()
    if _SENSITIVE_TEXT.search(text):
        return ""
    if len(text) <= limit:
        return text
    return f"{text[: limit - 1].rstrip()}…"


def _metadata_key(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _has_sensitive_query(query: str) -> bool:
    try:
        keys = {
            _metadata_key(key)
            for key, _ in parse_qsl(
                query,
                keep_blank_values=True,
                strict_parsing=False,
            )
        }
    except ValueError:
        return True
    return any(
        key in _SENSITIVE_QUERY_KEYS
        or any(part in key for part in _SENSITIVE_IDENTIFIER_PARTS)
        for key in keys
    )


def _has_sensitive_path(path: str) -> bool:
    try:
        decoded_segments = [
            decoded
            for segment in path.split("/")
            if segment
            for decoded in unquote(segment).split("/")
            if decoded
        ]
    except (UnicodeError, ValueError):
        return True
    for index, segment in enumerate(decoded_segments):
        pair = re.split(r"[:=]", segment, maxsplit=1)
        if (
            len(pair) == 2
            and _metadata_key(pair[0]) in _SENSITIVE_PATH_SEGMENTS
            and pair[1].strip()
        ):
            return True
        if (
            _metadata_key(segment) in _SENSITIVE_PATH_SEGMENTS
            and index + 1 < len(decoded_segments)
            and decoded_segments[index + 1].strip()
        ):
            return True
    return False


def _normalise_http_url(value: Any) -> tuple[str, str] | None:
    if not isinstance(value, str):
        return None
    raw = value.strip()
    if (
        not raw
        or len(raw) > _URL_LIMIT
        or any(ord(char) < 32 or ord(char) == 127 for char in raw)
    ):
        return None
    try:
        parsed = urlsplit(raw)
        scheme = parsed.scheme.lower()
        hostname = (parsed.hostname or "").rstrip(".").lower()
        port = parsed.port
    except ValueError:
        return None
    if (
        scheme not in {"http", "https"}
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or any(char.isspace() for char in hostname)
        or _has_sensitive_query(parsed.query)
        or _has_sensitive_path(parsed.path)
    ):
        return None

    display_host = hostname
    if ":" in display_host and not display_host.startswith("["):
        display_host = f"[{display_host}]"
    if port is not None and not (
        (scheme == "http" and port == 80)
        or (scheme == "https" and port == 443)
    ):
        display_host = f"{display_host}:{port}"
    url = urlunsplit(
        (scheme, display_host, parsed.path, parsed.query, "")
    )
    domain = hostname[4:] if hostname.startswith("www.") else hostname
    return url, domain


def build_source_record(
    *,
    url: Any,
    title: Any = None,
    snippet: Any = None,
) -> SourceRecord | None:
    """Build one bounded source record, rejecting unsafe or secret-bearing URLs."""
    normalised = _normalise_http_url(url)
    if normalised is None:
        return None
    safe_url, domain = normalised
    return SourceRecord(
        url=safe_url,
        title=_clean_text(title, limit=_TITLE_LIMIT) or domain,
        domain=domain,
        snippet=_clean_text(snippet, limit=_SNIPPET_LIMIT) or None,
    )


def _parse_structured_json(
    value: Any,
    *,
    bytes_limit: int = _JSON_BYTES_LIMIT,
) -> tuple[dict[str, Any] | list[Any] | None, bool]:
    if not isinstance(value, str):
        return None, False
    raw = value.strip()
    if not raw or raw[0] not in "[{":
        return None, False
    if (
        len(raw) > bytes_limit
        or len(raw.encode("utf-8")) > bytes_limit
    ):
        return None, True
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None, False
    if not isinstance(parsed, (dict, list)):
        return None, False
    return parsed, False


def _merge_record(
    records: dict[str, SourceRecord],
    record: SourceRecord,
) -> bool:
    current = records.get(record["url"])
    if current is None:
        if len(records) >= _SOURCE_LIMIT:
            return False
        records[record["url"]] = record
        return True
    if (
        current["title"] == current["domain"]
        and record["title"] != record["domain"]
    ):
        current["title"] = record["title"]
    if current["snippet"] is None and record["snippet"] is not None:
        current["snippet"] = record["snippet"]
    return True


def extract_source_evidence(value: Any) -> SourceEvidence:
    """Extract exact URL fields from bounded object/list data or whole JSON text.

    Ordinary prose is never searched for URL-looking substrings. A string is
    inspected only when the complete value safely parses as a JSON object/list.
    """
    root: Any
    if isinstance(value, (dict, list)):
        root = value
        root_incomplete = False
    else:
        root, root_incomplete = _parse_structured_json(value)
    if root is None:
        return SourceEvidence(
            items=[],
            truncated=root_incomplete,
            incomplete=root_incomplete,
            covered=root_incomplete,
        )

    records: dict[str, SourceRecord] = {}
    visited_nodes = 0
    truncated = False
    incomplete = False
    budget_exhausted = False
    nested_json_bytes_remaining = _NESTED_JSON_TOTAL_BYTES_LIMIT

    title_keys = ("title", "name", "label", "displayname", "filename")
    snippet_keys = (
        "snippet",
        "description",
        "summary",
        "excerpt",
        "quote",
    )
    label_keys = frozenset(title_keys + snippet_keys)

    def mark_incomplete() -> None:
        nonlocal truncated, incomplete
        truncated = True
        incomplete = True

    def consume_budget() -> bool:
        nonlocal visited_nodes, budget_exhausted
        if visited_nodes >= _NODE_LIMIT:
            budget_exhausted = True
            mark_incomplete()
            return False
        visited_nodes += 1
        return True

    def parse_child(child: Any) -> dict[str, Any] | list[Any] | None:
        nonlocal nested_json_bytes_remaining
        if not isinstance(child, str):
            return None
        raw = child.strip()
        if not raw or raw[0] not in "[{":
            return None
        if len(raw) > _NESTED_JSON_BYTES_LIMIT:
            mark_incomplete()
            return None
        raw_bytes = len(raw.encode("utf-8"))
        if (
            raw_bytes > _NESTED_JSON_BYTES_LIMIT
            or raw_bytes > nested_json_bytes_remaining
        ):
            mark_incomplete()
            return None
        nested_json_bytes_remaining -= raw_bytes
        structured, too_large = _parse_structured_json(
            raw,
            bytes_limit=_NESTED_JSON_BYTES_LIMIT,
        )
        if too_large:
            mark_incomplete()
        return structured

    def walk(item: Any, depth: int, *, counted: bool = False) -> None:
        nonlocal budget_exhausted
        if depth > _DEPTH_LIMIT:
            mark_incomplete()
            return
        if len(records) >= _SOURCE_LIMIT:
            mark_incomplete()
            return
        if not counted and not consume_budget():
            return
        if isinstance(item, dict):
            labels: dict[str, str] = {}
            url_values: list[str] = []
            children: list[dict[str, Any] | list[Any]] = []
            for key, child in item.items():
                if not consume_budget():
                    break
                normalised_key = _metadata_key(key)
                if (
                    normalised_key in label_keys
                    and isinstance(child, str)
                    and normalised_key not in labels
                ):
                    labels[normalised_key] = child
                if (
                    normalised_key in _URL_KEYS
                    and isinstance(child, str)
                ):
                    if len(url_values) < _SOURCE_LIMIT:
                        url_values.append(child)
                    else:
                        mark_incomplete()
                if isinstance(child, (dict, list)):
                    children.append(child)
                else:
                    structured = parse_child(child)
                    if structured is not None:
                        children.append(structured)
            title = next(
                (labels[key] for key in title_keys if key in labels),
                None,
            )
            snippet = next(
                (labels[key] for key in snippet_keys if key in labels),
                None,
            )
            for url in url_values:
                record = build_source_record(
                    url=url,
                    title=title,
                    snippet=snippet,
                )
                if (
                    record is not None
                    and not _merge_record(records, record)
                ):
                    mark_incomplete()
                    break
            if budget_exhausted:
                return
            for child in children:
                if len(records) >= _SOURCE_LIMIT:
                    mark_incomplete()
                    break
                walk(child, depth + 1, counted=True)
                if budget_exhausted:
                    break
        elif isinstance(item, list):
            for child in item:
                if len(records) >= _SOURCE_LIMIT:
                    mark_incomplete()
                    break
                if not consume_budget():
                    break
                if isinstance(child, (dict, list)):
                    walk(child, depth + 1, counted=True)
                else:
                    structured = parse_child(child)
                    if structured is not None:
                        walk(structured, depth + 1)
                if budget_exhausted:
                    break

    walk(root, 0)
    return SourceEvidence(
        items=list(records.values()),
        truncated=truncated,
        incomplete=incomplete,
        covered=True,
    )


def _metadata_item(record: SourceRecord) -> dict[str, str]:
    item = {
        "url": record["url"],
        "title": record["title"],
    }
    if record["snippet"] is not None:
        item["snippet"] = record["snippet"]
    return item


def merge_source_evidence(
    metadata: dict[str, Any],
    evidence: SourceEvidence | Iterable[SourceRecord],
) -> None:
    """Merge a compact, versioned source-evidence envelope into metadata.

    The budget applies to the complete metadata object, not only this envelope.
    Existing envelopes are always removed and rebuilt so malformed, oversized,
    or legacy payloads cannot survive persistence.
    """
    incoming: Iterable[SourceRecord]
    truncated = False
    incomplete = False
    coverage_requested = False
    if isinstance(evidence, SourceEvidence):
        incoming = evidence.items
        truncated = evidence.truncated
        incomplete = evidence.incomplete
        coverage_requested = evidence.covered
    else:
        incoming = evidence

    merged: dict[str, SourceRecord] = {}
    existing = metadata.pop(SOURCE_EVIDENCE_METADATA_KEY, None)

    def add_items(items: Iterable[Any]) -> None:
        nonlocal truncated, incomplete
        inspected = 0
        for item in items:
            if inspected >= _SOURCE_LIMIT:
                truncated = True
                incomplete = True
                break
            inspected += 1
            if not isinstance(item, dict):
                continue
            record = build_source_record(
                url=item.get("url"),
                title=item.get("title"),
                snippet=item.get("snippet"),
            )
            if record is not None and not _merge_record(merged, record):
                truncated = True
                incomplete = True

    if (
        isinstance(existing, dict)
        and existing.get("schema_version")
        == SOURCE_EVIDENCE_SCHEMA_VERSION
        and isinstance(existing.get("items"), list)
    ):
        coverage_requested = True
        truncated = truncated or existing.get("truncated") is True
        incomplete = incomplete or existing.get("incomplete") is True
        add_items(existing["items"])
    add_items(incoming)

    if not merged and not truncated and not incomplete and not coverage_requested:
        return

    try:
        base_size = len(
            json.dumps(
                metadata,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
        )
    except (TypeError, ValueError):
        return

    # Size pessimistically with both coverage flags. The final envelope can
    # only be smaller when one or both flags are unnecessary.
    empty_envelope = {
        "schema_version": SOURCE_EVIDENCE_SCHEMA_VERSION,
        "items": [],
        "truncated": True,
        "incomplete": True,
    }
    empty_envelope_size = len(
        json.dumps(
            empty_envelope,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    )
    key_size = len(
        json.dumps(
            SOURCE_EVIDENCE_METADATA_KEY,
            separators=(",", ":"),
        ).encode("utf-8")
    )
    separator_size = 1 if metadata else 0
    minimum_total_size = (
        base_size
        + separator_size
        + key_size
        + 1
        + empty_envelope_size
    )
    if minimum_total_size > _METADATA_BYTES_LIMIT:
        return

    remaining = _METADATA_BYTES_LIMIT - minimum_total_size
    compact_items: list[dict[str, str]] = []
    for record in merged.values():
        item = _metadata_item(record)
        item_size = len(
            json.dumps(
                item,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
        )
        required = item_size + (1 if compact_items else 0)
        if required > remaining:
            truncated = True
            incomplete = True
            break
        compact_items.append(item)
        remaining -= required

    envelope: dict[str, Any] = {
        "schema_version": SOURCE_EVIDENCE_SCHEMA_VERSION,
        "items": compact_items,
    }
    if truncated:
        envelope["truncated"] = True
    if incomplete:
        envelope["incomplete"] = True
    metadata[SOURCE_EVIDENCE_METADATA_KEY] = envelope


def has_source_evidence_coverage(metadata: dict[str, Any]) -> bool:
    """Return whether metadata contains a valid authoritative scan envelope."""
    envelope = metadata.get(SOURCE_EVIDENCE_METADATA_KEY)
    return (
        isinstance(envelope, dict)
        and envelope.get("schema_version")
        == SOURCE_EVIDENCE_SCHEMA_VERSION
        and isinstance(envelope.get("items"), list)
    )
