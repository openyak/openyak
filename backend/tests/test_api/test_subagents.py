"""Tests for the persisted child-Agent aggregate API."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.mcp.tool_wrapper import McpToolWrapper
from app.models.session_file import SessionFile
from app.session.manager import create_message, create_part, create_session

pytestmark = pytest.mark.asyncio


async def _parent_message(db, parent_id: str):
    return await create_message(
        db,
        session_id=parent_id,
        data={"role": "assistant"},
    )


async def _assistant_text(db, session_id: str, text: str) -> None:
    message = await create_message(
        db,
        session_id=session_id,
        data={"role": "assistant"},
    )
    await create_part(
        db,
        message_id=message.id,
        session_id=session_id,
        data={"type": "text", "text": text},
    )


class TestListSubagents:
    async def test_requires_parent_session_id(self, app_client):
        response = await app_client.get("/api/subagents")

        assert response.status_code == 422

    async def test_empty_parent(self, app_client):
        response = await app_client.get(
            "/api/subagents",
            params={"parent_session_id": "missing-parent"},
        )

        assert response.status_code == 200
        assert response.json() == {
            "active": [],
            "done": [],
            "counts": {"active": 0, "done": 0, "total": 0},
        }

    async def test_aggregates_task_and_swarm_runs(
        self,
        app_client,
        session_factory,
    ):
        now = datetime.now(timezone.utc)
        async with session_factory() as db:
            async with db.begin():
                parent = await create_session(db, title="Ultra parent")
                task_child = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Database audit",
                )
                active_child = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Frontend review",
                )
                done_child = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Contract tests",
                )
                message = await _parent_message(db, parent.id)
                task_part = await create_part(
                    db,
                    message_id=message.id,
                    session_id=parent.id,
                    data={
                        "type": "subtask",
                        "task_id": task_child.id,
                        "session_id": task_child.id,
                        "parent_id": parent.id,
                        "title": "Database audit",
                        "description": "Inspect persistence",
                        "agent": "explore",
                        "status": "failed",
                        "revision": 2,
                        "started_at": (now - timedelta(minutes=8)).isoformat(),
                        "finished_at": (now - timedelta(minutes=3)).isoformat(),
                        "error": "query failed",
                    },
                )
                task_part.time_updated = now - timedelta(minutes=3)
                swarm_part = await create_part(
                    db,
                    message_id=message.id,
                    session_id=parent.id,
                    data={
                        "type": "swarm",
                        "swarm_id": "swarm-1",
                        "parent_session_id": parent.id,
                        "revision": 4,
                        "status": "partial",
                        "started_at": (now - timedelta(minutes=7)).isoformat(),
                        "finished_at": now.isoformat(),
                        "members": [
                            {
                                "agent_run_id": "run-active",
                                "session_id": active_child.id,
                                "ordinal": 0,
                                "title": "Frontend review",
                                "agent": "research",
                                "status": "running",
                                "started_at": (
                                    now - timedelta(minutes=2)
                                ).isoformat(),
                            },
                            {
                                "agent_run_id": "run-done",
                                "session_id": done_child.id,
                                "ordinal": 1,
                                "title": "Contract tests",
                                "agent": "research",
                                "status": "completed",
                                "started_at": (
                                    now - timedelta(minutes=7)
                                ).isoformat(),
                                "finished_at": (
                                    now - timedelta(minutes=1)
                                ).isoformat(),
                            },
                        ],
                    },
                )
                swarm_part.time_updated = now
                await _assistant_text(
                    db,
                    done_child.id,
                    "## Final result\n\nAll   contract tests passed.",
                )

        response = await app_client.get(
            "/api/subagents",
            params={"parent_session_id": parent.id},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["counts"] == {"active": 1, "done": 2, "total": 3}
        assert [run["id"] for run in body["active"]] == ["run-active"]
        assert [run["id"] for run in body["done"]] == [
            "run-done",
            task_child.id,
        ]

        active = body["active"][0]
        assert active["parent_session_id"] == parent.id
        assert active["parent_title"] == "Ultra parent"
        assert active["session_id"] == active_child.id
        assert active["source"] == "swarm"
        assert active["swarm_id"] == "swarm-1"
        assert active["ordinal"] == 0
        assert active["summary"] is None

        completed = body["done"][0]
        assert completed["summary"] == "Final result All contract tests passed."
        assert completed["status"] == "completed"
        assert completed["last_message_at"] is not None
        assert body["done"][1]["summary"] == "query failed"
        assert body["done"][1]["last_message_at"] is None

    async def test_aggregates_valid_descendants_and_their_evidence(
        self,
        app_client,
        session_factory,
    ):
        async with session_factory() as db:
            async with db.begin():
                root = await create_session(db, title="Root")
                child = await create_session(
                    db,
                    parent_id=root.id,
                    title="Direct child",
                )
                grandchild = await create_session(
                    db,
                    parent_id=child.id,
                    title="Nested child",
                )
                foreign_parent = await create_session(
                    db,
                    title="Foreign parent",
                )
                foreign_child = await create_session(
                    db,
                    parent_id=foreign_parent.id,
                    title="Foreign child",
                )
                foreign_descendant = await create_session(
                    db,
                    parent_id=foreign_child.id,
                    title="Foreign descendant",
                )

                root_message = await _parent_message(db, root.id)
                await create_part(
                    db,
                    message_id=root_message.id,
                    session_id=root.id,
                    data={
                        "type": "subtask",
                        "session_id": child.id,
                        "title": "Direct worker",
                        "status": "completed",
                    },
                )
                child_message = await _parent_message(db, child.id)
                await create_part(
                    db,
                    message_id=child_message.id,
                    session_id=child.id,
                    data={
                        "type": "swarm",
                        "swarm_id": "nested-swarm",
                        "parent_session_id": child.id,
                        "revision": 1,
                        "members": [
                            {
                                "agent_run_id": "nested-run",
                                "session_id": grandchild.id,
                                "ordinal": 0,
                                "title": "Nested researcher",
                                "agent": "research",
                                "status": "running",
                            },
                            {
                                "agent_run_id": "cross-parent-run",
                                "session_id": foreign_child.id,
                                "ordinal": 1,
                                "title": "Cross-parent branch",
                                "agent": "research",
                                "status": "completed",
                            },
                            {
                                "agent_run_id": "deleted-run",
                                "session_id": "deleted-child",
                                "ordinal": 2,
                                "title": "Deleted branch",
                                "agent": "research",
                                "status": "completed",
                            },
                        ],
                    },
                )
                foreign_message = await _parent_message(
                    db,
                    foreign_child.id,
                )
                await create_part(
                    db,
                    message_id=foreign_message.id,
                    session_id=foreign_child.id,
                    data={
                        "type": "subtask",
                        "session_id": foreign_descendant.id,
                        "title": "Must not be traversed",
                        "status": "completed",
                    },
                )
                grandchild_message = await create_message(
                    db,
                    session_id=grandchild.id,
                    data={"role": "assistant"},
                )
                await create_part(
                    db,
                    message_id=grandchild_message.id,
                    session_id=grandchild.id,
                    data={
                        "type": "tool",
                        "tool": "web_search",
                        "call_id": "nested-search",
                        "state": {
                            "status": "completed",
                            "input": {"query": "nested evidence"},
                            "metadata": {
                                "results": [
                                    {
                                        "url": (
                                            "https://nested.example/evidence"
                                        ),
                                        "title": "Nested evidence",
                                        "snippet": "Grandchild research.",
                                    }
                                ]
                            },
                        },
                    },
                )
                db.add_all(
                    [
                        SessionFile(
                            session_id=child.id,
                            file_path="/workspace/direct.md",
                            file_name="direct.md",
                            tool_id="write",
                            file_type="generated",
                        ),
                        SessionFile(
                            session_id=grandchild.id,
                            file_path="/workspace/nested.md",
                            file_name="nested.md",
                            tool_id="write",
                            file_type="generated",
                        ),
                    ]
                )

        response = await app_client.get(
            "/api/subagents",
            params={"parent_session_id": root.id},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["counts"] == {"active": 1, "done": 1, "total": 2}
        runs = {
            run["session_id"]: run
            for run in body["active"] + body["done"]
        }
        assert set(runs) == {child.id, grandchild.id}
        assert runs[child.id]["parent_session_id"] == root.id
        assert runs[child.id]["outputs"][0]["path"] == (
            "/workspace/direct.md"
        )
        nested = runs[grandchild.id]
        assert nested["id"] == "nested-run"
        assert nested["parent_session_id"] == child.id
        assert nested["outputs"][0]["path"] == "/workspace/nested.md"
        assert nested["sources"][0]["url"] == (
            "https://nested.example/evidence"
        )
        assert nested["sources"][0]["origins"][0] == {
            "session_id": grandchild.id,
            "agent_run_id": "nested-run",
            "agent_title": "Nested researcher",
            "status": "running",
            "tool": "web_search",
        }

    async def test_deduplicates_latest_snapshot_and_filters_parent(
        self,
        app_client,
        session_factory,
    ):
        now = datetime.now(timezone.utc)
        async with session_factory() as db:
            async with db.begin():
                parent = await create_session(db, title="Selected")
                other_parent = await create_session(db, title="Other")
                child = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Latest child",
                )
                other_child = await create_session(
                    db,
                    parent_id=other_parent.id,
                    title="Other child",
                )
                parent_message = await _parent_message(db, parent.id)
                old = await create_part(
                    db,
                    message_id=parent_message.id,
                    session_id=parent.id,
                    data={
                        "type": "subtask",
                        "session_id": child.id,
                        "parent_id": parent.id,
                        "title": "Old snapshot",
                        "status": "running",
                        "revision": 1,
                    },
                )
                old.time_updated = now - timedelta(minutes=2)
                latest = await create_part(
                    db,
                    message_id=parent_message.id,
                    session_id=parent.id,
                    data={
                        "type": "subtask",
                        "session_id": child.id,
                        "parent_id": parent.id,
                        "title": "Latest snapshot",
                        "status": "completed",
                        "revision": 2,
                        "finished_at": now.isoformat(),
                    },
                )
                latest.time_updated = now
                other_message = await _parent_message(db, other_parent.id)
                await create_part(
                    db,
                    message_id=other_message.id,
                    session_id=other_parent.id,
                    data={
                        "type": "subtask",
                        "session_id": other_child.id,
                        "parent_id": other_parent.id,
                        "title": "Other task",
                        "status": "completed",
                        "revision": 2,
                    },
                )

        response = await app_client.get(
            "/api/subagents",
            params={"parent_session_id": parent.id},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["counts"] == {"active": 0, "done": 1, "total": 1}
        assert body["done"][0]["title"] == "Latest snapshot"
        assert body["done"][0]["session_id"] == child.id

    async def test_summary_is_one_line_and_bounded(
        self,
        app_client,
        session_factory,
    ):
        async with session_factory() as db:
            async with db.begin():
                parent = await create_session(db, title="Parent")
                child = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Writer",
                )
                message = await _parent_message(db, parent.id)
                await create_part(
                    db,
                    message_id=message.id,
                    session_id=parent.id,
                    data={
                        "type": "subtask",
                        "session_id": child.id,
                        "parent_id": parent.id,
                        "title": "Writer",
                        "status": "completed",
                    },
                )
                await _assistant_text(
                    db,
                    child.id,
                    "# Result\n" + ("word " * 100),
                )

        response = await app_client.get(
            "/api/subagents",
            params={"parent_session_id": parent.id},
        )

        summary = response.json()["done"][0]["summary"]
        assert "\n" not in summary
        assert len(summary) == 280
        assert summary.startswith("Result word word")
        assert summary.endswith("…")

    async def test_includes_child_outputs_and_web_sources(
        self,
        app_client,
        session_factory,
    ):
        async with session_factory() as db:
            async with db.begin():
                parent = await create_session(db, title="Parent")
                child = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Researcher",
                )
                parent_message = await _parent_message(db, parent.id)
                await create_part(
                    db,
                    message_id=parent_message.id,
                    session_id=parent.id,
                    data={
                        "type": "subtask",
                        "session_id": child.id,
                        "status": "completed",
                    },
                )
                assistant_message = await create_message(
                    db,
                    session_id=child.id,
                    data={"role": "assistant"},
                )
                await create_part(
                    db,
                    message_id=assistant_message.id,
                    session_id=child.id,
                    data={
                        "type": "tool",
                        "tool": "web_search",
                        "call_id": "search-1",
                        "state": {
                            "status": "completed",
                            "input": {"query": "OpenYak"},
                            "metadata": {
                                "results": [
                                    {
                                        "url": "https://docs.openyak.ai/guide",
                                        "title": "OpenYak Guide",
                                        "snippet": "Build durable agents.",
                                    }
                                ]
                            },
                        },
                    },
                )
                await create_part(
                    db,
                    message_id=assistant_message.id,
                    session_id=child.id,
                    data={
                        "type": "tool",
                        "tool": "web_fetch",
                        "call_id": "fetch-1",
                        "state": {
                            "status": "completed",
                            "input": {
                                "url": "https://example.com/reference"
                            },
                            "title": "Fetched Reference page",
                        },
                    },
                )
                db.add(
                    SessionFile(
                        session_id=child.id,
                        file_path="/workspace/report.md",
                        file_name="report.md",
                        tool_id="write",
                        file_type="generated",
                    )
                )

        response = await app_client.get(
            "/api/subagents",
            params={"parent_session_id": parent.id},
        )

        assert response.status_code == 200
        run = response.json()["done"][0]
        assert run["outputs"] == [
            {
                "name": "report.md",
                "path": "/workspace/report.md",
                "type": "generated",
                "tool": "write",
                "origins": [
                    {
                        "session_id": child.id,
                        "agent_run_id": child.id,
                        "agent_title": "Researcher",
                        "status": "completed",
                        "tool": "write",
                    }
                ],
            }
        ]
        assert run["sources"] == [
            {
                "url": "https://docs.openyak.ai/guide",
                "title": "OpenYak Guide",
                "domain": "docs.openyak.ai",
                "snippet": "Build durable agents.",
                "tool": "web_search",
                "origins": [
                    {
                        "session_id": child.id,
                        "agent_run_id": child.id,
                        "agent_title": "Researcher",
                        "status": "completed",
                        "tool": "web_search",
                    }
                ],
            },
            {
                "url": "https://example.com/reference",
                "title": "Reference page",
                "domain": "example.com",
                "snippet": None,
                "tool": "web_fetch",
                "origins": [
                    {
                        "session_id": child.id,
                        "agent_run_id": child.id,
                        "agent_title": "Researcher",
                        "status": "completed",
                        "tool": "web_fetch",
                    }
                ],
            },
        ]

    async def test_generic_metadata_is_safely_deduplicated_with_provenance(
        self,
        app_client,
        session_factory,
    ):
        async with session_factory() as db:
            async with db.begin():
                parent = await create_session(db, title="Parent")
                child = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Connector researcher",
                )
                parent_message = await _parent_message(db, parent.id)
                await create_part(
                    db,
                    message_id=parent_message.id,
                    session_id=parent.id,
                    data={
                        "type": "subtask",
                        "session_id": child.id,
                        "status": "failed",
                        "error": "Connector timed out after persistence",
                    },
                )
                assistant_message = await create_message(
                    db,
                    session_id=child.id,
                    data={"role": "assistant"},
                )
                await create_part(
                    db,
                    message_id=assistant_message.id,
                    session_id=child.id,
                    data={
                        "type": "tool",
                        "tool": "mcp__notion__search",
                        "call_id": "connector-1",
                        "state": {
                            "status": "completed",
                            "input": {"query": "agent architecture"},
                            "metadata": {
                                "payload": {
                                    "items": [
                                        {
                                            "webUrl": (
                                                " HTTPS://WWW.Example.com:443"
                                                "/docs#overview "
                                            ),
                                            "name": "Connector guide",
                                            "description": (
                                                "A  durable\nreference."
                                            ),
                                        },
                                        {
                                            "url": (
                                                "https://www.example.com/docs"
                                            ),
                                            "title": "Duplicate",
                                        },
                                        {
                                            "href": "javascript:alert(1)",
                                            "title": "Unsafe scheme",
                                        },
                                        {
                                            "uri": (
                                                "https://user:secret@"
                                                "example.com/private"
                                            ),
                                            "title": "Credentials",
                                        },
                                        {
                                            "link": "file:///etc/passwd",
                                            "title": "Local file",
                                        },
                                    ]
                                }
                            },
                        },
                    },
                )
                await create_part(
                    db,
                    message_id=assistant_message.id,
                    session_id=child.id,
                    data={
                        "type": "tool",
                        "tool": "web_fetch",
                        "call_id": "fetch-duplicate",
                        "state": {
                            "status": "completed",
                            "input": {
                                "url": "https://www.example.com/docs"
                            },
                            "title": "Fetched Direct guide",
                            "metadata": {
                                "url": "https://www.example.com/docs"
                            },
                        },
                    },
                )
                for tool_id in ("write", "write", "code_execute"):
                    db.add(
                        SessionFile(
                            session_id=child.id,
                            file_path="/workspace/shared.md",
                            file_name="shared.md",
                            tool_id=tool_id,
                            file_type="generated",
                        )
                    )

        response = await app_client.get(
            "/api/subagents",
            params={"parent_session_id": parent.id},
        )

        assert response.status_code == 200
        run = response.json()["done"][0]
        assert run["outputs"] == [
            {
                "name": "shared.md",
                "path": "/workspace/shared.md",
                "type": "generated",
                "tool": "write",
                "origins": [
                    {
                        "session_id": child.id,
                        "agent_run_id": child.id,
                        "agent_title": "Connector researcher",
                        "status": "failed",
                        "tool": "write",
                    },
                    {
                        "session_id": child.id,
                        "agent_run_id": child.id,
                        "agent_title": "Connector researcher",
                        "status": "failed",
                        "tool": "code_execute",
                    },
                ],
            },
        ]
        assert run["sources"] == [
            {
                "url": "https://www.example.com/docs",
                "title": "Connector guide",
                "domain": "example.com",
                "snippet": "A durable reference.",
                "tool": "mcp__notion__search",
                "origins": [
                    {
                        "session_id": child.id,
                        "agent_run_id": child.id,
                        "agent_title": "Connector researcher",
                        "status": "failed",
                        "tool": "mcp__notion__search",
                    },
                    {
                        "session_id": child.id,
                        "agent_run_id": child.id,
                        "agent_title": "Connector researcher",
                        "status": "failed",
                        "tool": "web_fetch",
                    },
                ],
            },
        ]

    async def test_parses_structured_json_but_not_arbitrary_metadata_text(
        self,
        app_client,
        session_factory,
    ):
        async with session_factory() as db:
            async with db.begin():
                parent = await create_session(db, title="Parent")
                child = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Cancelled connector",
                )
                parent_message = await _parent_message(db, parent.id)
                await create_part(
                    db,
                    message_id=parent_message.id,
                    session_id=parent.id,
                    data={
                        "type": "subtask",
                        "session_id": child.id,
                        "status": "cancelled",
                    },
                )
                assistant_message = await create_message(
                    db,
                    session_id=child.id,
                    data={"role": "assistant"},
                )
                await create_part(
                    db,
                    message_id=assistant_message.id,
                    session_id=child.id,
                    data={
                        "type": "tool",
                        "tool": "mcp__drive__search",
                        "call_id": "connector-json",
                        "state": {
                            "status": "completed",
                            "input": {"query": "release"},
                            "metadata": {
                                "raw_json": (
                                    '{"items":[{"url":'
                                    '"https://json.example/release#latest",'
                                    '"title":"Release plan",'
                                    '"summary":"Approved plan."}]}'
                                ),
                                "note": (
                                    "Do not infer "
                                    "https://ignored.example/from-text"
                                ),
                            },
                        },
                    },
                )

        response = await app_client.get(
            "/api/subagents",
            params={"parent_session_id": parent.id},
        )

        assert response.status_code == 200
        run = response.json()["done"][0]
        assert run["status"] == "cancelled"
        assert run["sources"] == [
            {
                "url": "https://json.example/release",
                "title": "Release plan",
                "domain": "json.example",
                "snippet": "Approved plan.",
                "tool": "mcp__drive__search",
                "origins": [
                    {
                        "session_id": child.id,
                        "agent_run_id": child.id,
                        "agent_title": "Cancelled connector",
                        "status": "cancelled",
                        "tool": "mcp__drive__search",
                    }
                ],
            }
        ]

    async def test_extracts_sources_from_structured_connector_output_only(
        self,
        app_client,
        session_factory,
    ):
        async with session_factory() as db:
            async with db.begin():
                parent = await create_session(db, title="Parent")
                child = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Output connector",
                )
                parent_message = await _parent_message(db, parent.id)
                await create_part(
                    db,
                    message_id=parent_message.id,
                    session_id=parent.id,
                    data={
                        "type": "subtask",
                        "session_id": child.id,
                        "status": "completed",
                    },
                )
                assistant_message = await create_message(
                    db,
                    session_id=child.id,
                    data={"role": "assistant"},
                )
                await create_part(
                    db,
                    message_id=assistant_message.id,
                    session_id=child.id,
                    data={
                        "type": "tool",
                        "tool": "mcp__notion__search",
                        "call_id": "output-object",
                        "state": {
                            "status": "completed",
                            "input": {"query": "release"},
                            "output": (
                                '{"results":['
                                '{"webUrl":'
                                '"https://connector.example/web#section",'
                                '"name":"Web result",'
                                '"description":"From webUrl."},'
                                '{"permalink":'
                                '"https://connector.example/permalink",'
                                '"title":"Permanent result"}]}'
                            ),
                            "metadata": {},
                        },
                    },
                )
                await create_part(
                    db,
                    message_id=assistant_message.id,
                    session_id=child.id,
                    data={
                        "type": "tool",
                        "tool": "mcp__drive__search",
                        "call_id": "output-list",
                        "state": {
                            "status": "completed",
                            "input": {"query": "design"},
                            "output": (
                                '[{"sourceUrl":'
                                '"https://connector.example/source",'
                                '"label":"Source result"},'
                                '{"canonicalUrl":'
                                '"https://connector.example/canonical",'
                                '"title":"Canonical result"},'
                                '{"avatarUrl":'
                                '"https://connector.example/avatar",'
                                '"title":"Not a source"}]'
                            ),
                        },
                    },
                )
                await create_part(
                    db,
                    message_id=assistant_message.id,
                    session_id=child.id,
                    data={
                        "type": "tool",
                        "tool": "mcp__slack__search",
                        "call_id": "output-text",
                        "state": {
                            "status": "completed",
                            "input": {"query": "ignored"},
                            "output": (
                                "Ordinary text mentions "
                                "https://ignored.example/from-text"
                            ),
                            "metadata": {},
                        },
                    },
                )

        response = await app_client.get(
            "/api/subagents",
            params={"parent_session_id": parent.id},
        )

        assert response.status_code == 200
        run = response.json()["done"][0]
        sources = {source["url"]: source for source in run["sources"]}
        assert set(sources) == {
            "https://connector.example/web",
            "https://connector.example/permalink",
            "https://connector.example/source",
            "https://connector.example/canonical",
        }
        assert sources["https://connector.example/web"]["title"] == (
            "Web result"
        )
        assert sources["https://connector.example/web"]["snippet"] == (
            "From webUrl."
        )
        assert sources["https://connector.example/web"]["tool"] == (
            "mcp__notion__search"
        )
        assert sources["https://connector.example/source"]["tool"] == (
            "mcp__drive__search"
        )
        assert sources["https://connector.example/source"]["origins"] == [
            {
                "session_id": child.id,
                "agent_run_id": child.id,
                "agent_title": "Output connector",
                "status": "completed",
                "tool": "mcp__drive__search",
            }
        ]

    async def test_authoritative_empty_envelope_blocks_raw_fallback(
        self,
        app_client,
        session_factory,
    ):
        async with session_factory() as db:
            async with db.begin():
                parent = await create_session(db, title="Parent")
                child = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Filtered connector",
                )
                parent_message = await _parent_message(db, parent.id)
                await create_part(
                    db,
                    message_id=parent_message.id,
                    session_id=parent.id,
                    data={
                        "type": "subtask",
                        "session_id": child.id,
                        "status": "completed",
                    },
                )
                assistant_message = await create_message(
                    db,
                    session_id=child.id,
                    data={"role": "assistant"},
                )
                await create_part(
                    db,
                    message_id=assistant_message.id,
                    session_id=child.id,
                    data={
                        "type": "tool",
                        "tool": "mcp__drive__search",
                        "call_id": "filtered-output",
                        "state": {
                            "status": "completed",
                            "output": json.dumps(
                                {
                                    "url": (
                                        "https://fallback.example/"
                                        "must-not-be-read"
                                    )
                                }
                            ),
                            "metadata": {
                                "source_evidence": {
                                    "schema_version": 1,
                                    "items": [],
                                },
                                "raw": {
                                    "url": (
                                        "https://fallback.example/"
                                        "metadata-must-not-be-read"
                                    )
                                },
                            },
                        },
                    },
                )

        response = await app_client.get(
            "/api/subagents",
            params={"parent_session_id": parent.id},
        )

        assert response.status_code == 200
        assert response.json()["done"][0]["sources"] == []

    async def test_generic_tool_json_is_not_legacy_source_evidence(
        self,
        app_client,
        session_factory,
    ):
        async with session_factory() as db:
            async with db.begin():
                parent = await create_session(db, title="Parent")
                child = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Generic tools",
                )
                parent_message = await _parent_message(db, parent.id)
                await create_part(
                    db,
                    message_id=parent_message.id,
                    session_id=parent.id,
                    data={
                        "type": "subtask",
                        "session_id": child.id,
                        "status": "completed",
                    },
                )
                assistant_message = await create_message(
                    db,
                    session_id=child.id,
                    data={"role": "assistant"},
                )
                for tool in ("read", "bash", "code_execute"):
                    await create_part(
                        db,
                        message_id=assistant_message.id,
                        session_id=child.id,
                        data={
                            "type": "tool",
                            "tool": tool,
                            "call_id": f"{tool}-json",
                            "state": {
                                "status": "completed",
                                "output": json.dumps(
                                    {
                                        "url": (
                                            "https://generic.example/"
                                            f"{tool}-output"
                                        )
                                    }
                                ),
                                "metadata": {
                                    "url": (
                                        "https://generic.example/"
                                        f"{tool}-metadata"
                                    )
                                },
                            },
                        },
                    )
                await create_part(
                    db,
                    message_id=assistant_message.id,
                    session_id=child.id,
                    data={
                        "type": "tool",
                        "tool": "read",
                        "call_id": "read-authoritative",
                        "state": {
                            "status": "completed",
                            "output": json.dumps(
                                {
                                    "url": (
                                        "https://generic.example/"
                                        "ignored-output"
                                    )
                                }
                            ),
                            "metadata": {
                                "source_evidence": {
                                    "schema_version": 1,
                                    "items": [
                                        {
                                            "url": (
                                                "https://evidence.example/"
                                                "explicit"
                                            ),
                                            "title": "Explicit evidence",
                                        }
                                    ],
                                },
                                "url": (
                                    "https://generic.example/"
                                    "ignored-metadata"
                                ),
                            },
                        },
                    },
                )

        response = await app_client.get(
            "/api/subagents",
            params={"parent_session_id": parent.id},
        )

        assert response.status_code == 200
        assert response.json()["done"][0]["sources"] == [
            {
                "url": "https://evidence.example/explicit",
                "title": "Explicit evidence",
                "domain": "evidence.example",
                "snippet": None,
                "tool": "read",
                "origins": [
                    {
                        "session_id": child.id,
                        "agent_run_id": child.id,
                        "agent_title": "Generic tools",
                        "status": "completed",
                        "tool": "read",
                    }
                ],
            }
        ]

    async def test_large_mcp_json_survives_tool_truncation_into_summary(
        self,
        app_client,
        session_factory,
        tmp_path,
    ):
        source_url = "https://large-mcp.example/source#section"
        raw_output = json.dumps(
            {
                "padding": "x" * (60 * 1024),
                "results": [
                    {
                        "webUrl": source_url,
                        "title": "Large MCP source",
                        "description": "Preserved before truncation.",
                    }
                ],
            }
        )
        call_result = SimpleNamespace(
            content=[
                SimpleNamespace(type="text", text=raw_output),
                SimpleNamespace(
                    type="resource_link",
                    uri="https://resource.example/link#details",
                    name="linked-resource",
                    title="Linked resource",
                    description="Protocol resource link.",
                ),
                SimpleNamespace(
                    type="resource_link",
                    uri=(
                        "https://resource.example/private"
                        "?access_token=do-not-persist"
                    ),
                    name="private-resource",
                    title="Private resource",
                    description="Must be rejected.",
                ),
                SimpleNamespace(
                    type="resource",
                    resource=SimpleNamespace(
                        uri="https://resource.example/embedded#section",
                        text="Embedded resource body.",
                    ),
                ),
                SimpleNamespace(
                    type="resource",
                    resource=SimpleNamespace(
                        uri="file:///private/local.txt",
                        text="Local resource body.",
                    ),
                ),
            ],
            structuredContent={
                "padding": "structured-secret-" * 4000,
                "items": [
                    {
                        "canonicalUrl": (
                            "https://structured.example/canonical"
                        ),
                        "title": "Canonical source",
                    },
                    {
                        "externalUrl": (
                            "https://structured.example/external"
                        ),
                        "title": "External source",
                    },
                    {
                        "pageUrl": "https://structured.example/page",
                        "title": "Page source",
                    },
                    {
                        "documentUrl": (
                            "https://structured.example/document"
                        ),
                        "title": "Document source",
                    },
                    {
                        "callbackUrl": (
                            "https://structured.example/callback"
                        ),
                        "title": "Callback is not evidence",
                    },
                ],
            },
            isError=False,
        )

        class FakeMcpClient:
            name = "research"

            @staticmethod
            def tool_id(name):
                return f"mcp__research__{name}"

            @staticmethod
            async def call_tool(name, args):
                return call_result

        wrapper = McpToolWrapper(
            FakeMcpClient(),
            SimpleNamespace(
                name="search",
                description="Search research",
                inputSchema={"type": "object", "properties": {}},
            ),
        )
        tool_result = await wrapper(
            {},
            SimpleNamespace(
                workspace=str(tmp_path),
                agent=SimpleNamespace(tools=[]),
            ),
        )

        assert len(raw_output.encode("utf-8")) > 50 * 1024
        assert tool_result.metadata["truncated"] is True
        assert source_url not in tool_result.output
        serialised_metadata = json.dumps(tool_result.metadata)
        assert len(serialised_metadata.encode("utf-8")) <= 64 * 1024
        assert "structured-secret" not in serialised_metadata
        assert "do-not-persist" not in serialised_metadata

        async with session_factory() as db:
            async with db.begin():
                parent = await create_session(db, title="Parent")
                child = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Large MCP child",
                )
                parent_message = await _parent_message(db, parent.id)
                await create_part(
                    db,
                    message_id=parent_message.id,
                    session_id=parent.id,
                    data={
                        "type": "subtask",
                        "session_id": child.id,
                        "status": "completed",
                    },
                )
                assistant_message = await create_message(
                    db,
                    session_id=child.id,
                    data={"role": "assistant"},
                )
                await create_part(
                    db,
                    message_id=assistant_message.id,
                    session_id=child.id,
                    data={
                        "type": "tool",
                        "tool": wrapper.id,
                        "call_id": "large-mcp",
                        "state": {
                            "status": "completed",
                            "input": {},
                            "output": tool_result.output,
                            "title": tool_result.title,
                            "metadata": tool_result.metadata,
                        },
                    },
                )

        response = await app_client.get(
            "/api/subagents",
            params={"parent_session_id": parent.id},
        )

        assert response.status_code == 200
        run = response.json()["done"][0]
        sources = {source["url"]: source for source in run["sources"]}
        assert set(sources) == {
            "https://large-mcp.example/source",
            "https://resource.example/link",
            "https://resource.example/embedded",
            "https://structured.example/canonical",
            "https://structured.example/external",
            "https://structured.example/page",
            "https://structured.example/document",
        }
        large_source = sources["https://large-mcp.example/source"]
        assert large_source["title"] == "Large MCP source"
        assert large_source["snippet"] == "Preserved before truncation."
        assert large_source["origins"] == [
            {
                "session_id": child.id,
                "agent_run_id": child.id,
                "agent_title": "Large MCP child",
                "status": "completed",
                "tool": "mcp__research__search",
            }
        ]
        linked = sources["https://resource.example/link"]
        assert linked["title"] == "Linked resource"
        assert linked["snippet"] == "Protocol resource link."

    async def test_rejects_parent_payload_mismatch_and_cross_parent_child(
        self,
        app_client,
        session_factory,
    ):
        async with session_factory() as db:
            async with db.begin():
                parent = await create_session(db, title="Selected parent")
                other_parent = await create_session(db, title="Other parent")
                valid_child = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Valid child",
                )
                mismatched_payload_child = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Payload mismatch",
                )
                foreign_child = await create_session(
                    db,
                    parent_id=other_parent.id,
                    title="Foreign child",
                )
                swarm_payload_child = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Swarm payload mismatch",
                )
                message = await _parent_message(db, parent.id)
                await create_part(
                    db,
                    message_id=message.id,
                    session_id=parent.id,
                    data={
                        "type": "subtask",
                        "session_id": valid_child.id,
                        "parent_id": parent.id,
                        "title": "Valid child",
                        "status": "completed",
                    },
                )
                await create_part(
                    db,
                    message_id=message.id,
                    session_id=parent.id,
                    data={
                        "type": "subtask",
                        "session_id": mismatched_payload_child.id,
                        "parent_id": other_parent.id,
                        "title": "Payload mismatch",
                        "status": "completed",
                    },
                )
                await create_part(
                    db,
                    message_id=message.id,
                    session_id=parent.id,
                    data={
                        "type": "subtask",
                        "session_id": foreign_child.id,
                        "parent_id": parent.id,
                        "title": "Foreign child",
                        "status": "completed",
                    },
                )
                await create_part(
                    db,
                    message_id=message.id,
                    session_id=parent.id,
                    data={
                        "type": "swarm",
                        "parent_session_id": other_parent.id,
                        "members": [
                            {
                                "session_id": swarm_payload_child.id,
                                "title": "Swarm payload mismatch",
                                "status": "running",
                            }
                        ],
                    },
                )
                foreign_message = await create_message(
                    db,
                    session_id=foreign_child.id,
                    data={"role": "assistant"},
                )
                await create_part(
                    db,
                    message_id=foreign_message.id,
                    session_id=foreign_child.id,
                    data={
                        "type": "tool",
                        "tool": "web_fetch",
                        "call_id": "foreign-source",
                        "state": {
                            "status": "completed",
                            "input": {
                                "url": "https://foreign.example/private"
                            },
                            "metadata": {
                                "url": "https://foreign.example/private"
                            },
                        },
                    },
                )
                db.add(
                    SessionFile(
                        session_id=foreign_child.id,
                        file_path="/foreign/private.md",
                        file_name="private.md",
                        tool_id="write",
                        file_type="generated",
                    )
                )

        response = await app_client.get(
            "/api/subagents",
            params={"parent_session_id": parent.id},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["counts"] == {"active": 0, "done": 1, "total": 1}
        assert [run["session_id"] for run in body["done"]] == [
            valid_child.id
        ]
        assert body["done"][0]["outputs"] == []
        assert body["done"][0]["sources"] == []

    async def test_deduplication_has_stable_part_tiebreakers(
        self,
        app_client,
        session_factory,
    ):
        now = datetime.now(timezone.utc)
        async with session_factory() as db:
            async with db.begin():
                parent = await create_session(db, title="Parent")
                child = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Child title",
                )
                message = await _parent_message(db, parent.id)
                earlier = await create_part(
                    db,
                    message_id=message.id,
                    session_id=parent.id,
                    part_id="tie-z",
                    data={
                        "type": "subtask",
                        "session_id": child.id,
                        "title": "Earlier creation",
                        "status": "running",
                        "revision": 7,
                    },
                )
                later_a = await create_part(
                    db,
                    message_id=message.id,
                    session_id=parent.id,
                    part_id="tie-a",
                    data={
                        "type": "subtask",
                        "session_id": child.id,
                        "title": "Later creation",
                        "status": "running",
                        "revision": 7,
                    },
                )
                later_b = await create_part(
                    db,
                    message_id=message.id,
                    session_id=parent.id,
                    part_id="tie-b",
                    data={
                        "type": "subtask",
                        "session_id": child.id,
                        "title": "Stable ID winner",
                        "status": "completed",
                        "revision": 7,
                    },
                )
                earlier.time_updated = now
                later_a.time_updated = now
                later_b.time_updated = now
                earlier.time_created = now - timedelta(seconds=1)
                later_a.time_created = now
                later_b.time_created = now

        response = await app_client.get(
            "/api/subagents",
            params={"parent_session_id": parent.id},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["counts"] == {"active": 0, "done": 1, "total": 1}
        assert body["done"][0]["title"] == "Stable ID winner"

    async def test_unknown_statuses_are_skipped_but_missing_uses_legacy_default(
        self,
        app_client,
        session_factory,
    ):
        async with session_factory() as db:
            async with db.begin():
                parent = await create_session(db, title="Parent")
                unknown_task = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Unknown task",
                )
                legacy_task = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Child title fallback",
                )
                unknown_swarm = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Unknown swarm",
                )
                legacy_swarm = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Legacy swarm",
                )
                message = await _parent_message(db, parent.id)
                await create_part(
                    db,
                    message_id=message.id,
                    session_id=parent.id,
                    data={
                        "type": "subtask",
                        "session_id": unknown_task.id,
                        "status": "paused",
                    },
                )
                await create_part(
                    db,
                    message_id=message.id,
                    session_id=parent.id,
                    data={
                        "type": "subtask",
                        "session_id": legacy_task.id,
                    },
                )
                await create_part(
                    db,
                    message_id=message.id,
                    session_id=parent.id,
                    data={
                        "type": "swarm",
                        "members": [
                            {
                                "session_id": unknown_swarm.id,
                                "status": "paused",
                            },
                            {
                                "session_id": legacy_swarm.id,
                            },
                        ],
                    },
                )

        response = await app_client.get(
            "/api/subagents",
            params={"parent_session_id": parent.id},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["counts"] == {"active": 1, "done": 1, "total": 2}
        assert body["active"][0]["session_id"] == legacy_swarm.id
        assert body["active"][0]["status"] == "pending"
        assert body["done"][0]["session_id"] == legacy_task.id
        assert body["done"][0]["status"] == "completed"
        assert body["done"][0]["title"] == "Child title fallback"
        assert body["done"][0]["summary"] is None

    async def test_response_datetimes_are_utc_aware(
        self,
        app_client,
        session_factory,
    ):
        started = "2026-01-02T03:04:05-05:00"
        finished = "2026-01-02T04:04:05-05:00"
        async with session_factory() as db:
            async with db.begin():
                parent = await create_session(db, title="Parent")
                child = await create_session(
                    db,
                    parent_id=parent.id,
                    title="Timezone child",
                )
                parent_message = await _parent_message(db, parent.id)
                state = await create_part(
                    db,
                    message_id=parent_message.id,
                    session_id=parent.id,
                    data={
                        "type": "subtask",
                        "session_id": child.id,
                        "status": "completed",
                        "started_at": started,
                        "finished_at": finished,
                    },
                )
                state.time_updated = datetime(2026, 1, 2, 10, 0, 0)
                assistant_message = await create_message(
                    db,
                    session_id=child.id,
                    data={"role": "assistant"},
                )
                assistant_message.time_created = datetime(
                    2026,
                    1,
                    2,
                    9,
                    30,
                    0,
                )
                await create_part(
                    db,
                    message_id=assistant_message.id,
                    session_id=child.id,
                    data={"type": "text", "text": "UTC preview"},
                )

        response = await app_client.get(
            "/api/subagents",
            params={"parent_session_id": parent.id},
        )

        assert response.status_code == 200
        run = response.json()["done"][0]
        parsed = {
            field: datetime.fromisoformat(run[field].replace("Z", "+00:00"))
            for field in (
                "started_at",
                "finished_at",
                "last_message_at",
                "time_updated",
            )
        }
        assert all(
            value.utcoffset() == timedelta(0) for value in parsed.values()
        )
        assert parsed["started_at"] == datetime(
            2026,
            1,
            2,
            8,
            4,
            5,
            tzinfo=timezone.utc,
        )
        assert parsed["finished_at"] == datetime(
            2026,
            1,
            2,
            9,
            4,
            5,
            tzinfo=timezone.utc,
        )
