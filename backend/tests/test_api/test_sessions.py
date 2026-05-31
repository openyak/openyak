"""Tests for session CRUD API endpoints."""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.asyncio


class TestListSessions:
    async def test_empty(self, app_client):
        resp = await app_client.get("/api/sessions")
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_returns_created(self, app_client):
        await app_client.post("/api/sessions", json={"title": "First"})
        await app_client.post("/api/sessions", json={"title": "Second"})
        resp = await app_client.get("/api/sessions")
        assert resp.status_code == 200
        assert len(resp.json()) == 2

    async def test_pagination(self, app_client):
        for i in range(5):
            await app_client.post("/api/sessions", json={"title": f"S{i}"})
        resp = await app_client.get("/api/sessions", params={"limit": 2, "offset": 0})
        assert resp.status_code == 200
        assert len(resp.json()) == 2

    async def test_project_id_filter(self, app_client):
        await app_client.post("/api/sessions", json={"title": "A", "project_id": "p1"})
        await app_client.post("/api/sessions", json={"title": "B", "project_id": "p2"})
        resp = await app_client.get("/api/sessions", params={"project_id": "p1"})
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["project_id"] == "p1"


class TestCreateSession:
    async def test_success(self, app_client):
        resp = await app_client.post("/api/sessions", json={"title": "Test"})
        assert resp.status_code == 201
        data = resp.json()
        assert data["title"] == "Test"
        assert "id" in data

    async def test_defaults(self, app_client):
        resp = await app_client.post("/api/sessions", json={})
        assert resp.status_code == 201
        assert resp.json()["title"] == "New Session"

    async def test_with_directory(self, app_client):
        resp = await app_client.post(
            "/api/sessions",
            json={"title": "X", "project_id": "proj", "directory": "/tmp/test"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["project_id"] == "proj"
        assert data["directory"] == "/tmp/test"


class TestGetSession:
    async def test_existing(self, app_client):
        create = await app_client.post("/api/sessions", json={"title": "Get me"})
        sid = create.json()["id"]
        resp = await app_client.get(f"/api/sessions/{sid}")
        assert resp.status_code == 200
        assert resp.json()["title"] == "Get me"

    async def test_not_found(self, app_client):
        resp = await app_client.get("/api/sessions/nonexistent")
        assert resp.status_code == 404

    async def test_model_fields_present_and_null_for_fresh_session(self, app_client):
        """Per-session model memory: the model_id/provider_id fields are part
        of the session response, and null until a prompt sets them."""
        create = await app_client.post("/api/sessions", json={"title": "M"})
        body = create.json()
        assert body["model_id"] is None
        assert body["provider_id"] is None

        resp = await app_client.get(f"/api/sessions/{body['id']}")
        got = resp.json()
        assert "model_id" in got and got["model_id"] is None
        assert "provider_id" in got and got["provider_id"] is None


class TestUpdateSession:
    async def test_update_title(self, app_client):
        create = await app_client.post("/api/sessions", json={"title": "Old"})
        sid = create.json()["id"]
        resp = await app_client.patch(f"/api/sessions/{sid}", json={"title": "New"})
        assert resp.status_code == 200
        assert resp.json()["title"] == "New"

    async def test_not_found(self, app_client):
        resp = await app_client.patch("/api/sessions/nope", json={"title": "X"})
        assert resp.status_code == 404

    async def test_update_directory(self, app_client):
        create = await app_client.post("/api/sessions", json={})
        sid = create.json()["id"]
        resp = await app_client.patch(f"/api/sessions/{sid}", json={"directory": "/new"})
        assert resp.status_code == 200
        assert resp.json()["directory"] == "/new"


class TestDeleteSession:
    async def test_success(self, app_client):
        create = await app_client.post("/api/sessions", json={"title": "Del"})
        sid = create.json()["id"]
        resp = await app_client.delete(f"/api/sessions/{sid}")
        assert resp.status_code == 200
        assert resp.json()["deleted"] is True
        assert (await app_client.get(f"/api/sessions/{sid}")).status_code == 404

    async def test_not_found(self, app_client):
        resp = await app_client.delete("/api/sessions/nonexistent")
        assert resp.status_code == 404


class TestSearchSessions:
    async def test_empty_query(self, app_client):
        resp = await app_client.get("/api/sessions/search", params={"q": ""})
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_by_title(self, app_client):
        await app_client.post("/api/sessions", json={"title": "Python tutorial"})
        await app_client.post("/api/sessions", json={"title": "Rust guide"})
        resp = await app_client.get("/api/sessions/search", params={"q": "Python"})
        assert resp.status_code == 200
        results = resp.json()
        assert len(results) >= 1
