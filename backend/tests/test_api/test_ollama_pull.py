"""API tests for ``/ollama/models/pull`` cloud-model handling."""

from __future__ import annotations

import json

import pytest

from app.api.ollama import _is_cloud_model_tag


@pytest.mark.parametrize(
    "name,expected",
    [
        ("glm-5.1:cloud", True),
        ("qwen3:cloud", True),
        ("user/glm-5.1:cloud", True),
        ("glm-5.1", False),
        ("llama3.2:3b", False),
        ("library/llama3.2:3b", False),
        ("cloudburst:7b", False),
    ],
)
def test_cloud_tag_detection(name: str, expected: bool) -> None:
    assert _is_cloud_model_tag(name) is expected


@pytest.mark.asyncio
async def test_pull_cloud_model_short_circuits_with_redirect_message(app_client) -> None:
    """Cloud-tagged pulls return a structured SSE error without touching Ollama."""
    resp = await app_client.post(
        "/api/ollama/models/pull",
        json={"name": "glm-5.1:cloud"},
    )
    assert resp.status_code == 200
    body = resp.text

    # Single SSE event, JSON payload after "data: "
    line = body.strip().splitlines()[0]
    assert line.startswith("data: ")
    payload = json.loads(line[len("data: "):])

    assert payload["status"] == "error"
    assert payload["reason"] == "cloud_model_unsupported"
    assert "glm-5.1:cloud" in payload["message"]
    # The message should redirect the user to alternative providers / local tags.
    assert "local" in payload["message"].lower()


@pytest.mark.asyncio
async def test_pull_local_tag_does_not_short_circuit(app_client) -> None:
    """Non-cloud tags fall through; without a running Ollama manager the route
    surfaces the manager-not-initialized 503 — proving the cloud-block branch
    didn't swallow it."""
    resp = await app_client.post(
        "/api/ollama/models/pull",
        json={"name": "llama3.2:3b"},
    )
    assert resp.status_code == 503
    assert "Ollama manager" in resp.text
