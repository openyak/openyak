"""Persistent token storage for MCP OAuth tokens."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from app.mcp.oauth import AuthServerMeta, TokenSet
from app.utils.atomic_write import atomic_write_text, file_lock

logger = logging.getLogger(__name__)


class McpTokenStore:
    """Persist OAuth tokens per MCP server to a JSON file.

    Storage path: {project_dir}/.openyak/mcp-tokens.json
    Fallback:     ~/.openyak/mcp-tokens.json
    """

    def __init__(self, project_dir: str | None = None) -> None:
        if project_dir:
            self._path = Path(project_dir).resolve() / ".openyak" / "mcp-tokens.json"
        else:
            self._path = Path.home() / ".openyak" / "mcp-tokens.json"
        self._data: dict[str, dict[str, Any]] = self._load()
        self._migrate_namespaced_keys()

    def get(self, server_name: str) -> TokenSet | None:
        """Retrieve stored tokens for a server."""
        entry = self._data.get(server_name)
        if not entry:
            return None
        return TokenSet(
            access_token=entry.get("access_token", ""),
            refresh_token=entry.get("refresh_token"),
            expires_at=entry.get("expires_at", 0.0),
            token_type=entry.get("token_type", "Bearer"),
            scope=entry.get("scope", ""),
        )

    def get_auth_meta(self, server_name: str) -> AuthServerMeta | None:
        """Retrieve stored auth server metadata for a server."""
        entry = self._data.get(server_name)
        if not entry or "auth_meta" not in entry:
            return None
        meta = entry["auth_meta"]
        return AuthServerMeta(
            authorization_endpoint=meta.get("authorization_endpoint", ""),
            token_endpoint=meta.get("token_endpoint", ""),
            scopes=meta.get("scopes", []),
            resource_url=meta.get("resource_url", ""),
            registration_endpoint=meta.get("registration_endpoint", ""),
            client_id_metadata_document_supported=meta.get(
                "client_id_metadata_document_supported", False
            ),
        )

    def save(
        self,
        server_name: str,
        tokens: TokenSet,
        auth_meta: AuthServerMeta | None = None,
    ) -> None:
        """Store tokens for a server."""
        entry: dict[str, Any] = {
            "access_token": tokens.access_token,
            "refresh_token": tokens.refresh_token,
            "expires_at": tokens.expires_at,
            "token_type": tokens.token_type,
            "scope": tokens.scope,
        }
        if auth_meta:
            entry["auth_meta"] = {
                "authorization_endpoint": auth_meta.authorization_endpoint,
                "token_endpoint": auth_meta.token_endpoint,
                "scopes": auth_meta.scopes,
                "resource_url": auth_meta.resource_url,
                "registration_endpoint": auth_meta.registration_endpoint,
                "client_id_metadata_document_supported": auth_meta.client_id_metadata_document_supported,
            }
        self._data[server_name] = entry
        self._persist()

    def delete(self, server_name: str) -> None:
        """Remove stored tokens for a server."""
        if server_name in self._data:
            del self._data[server_name]
            self._persist()

    def has_token(self, server_name: str) -> bool:
        """Check if we have tokens stored for a server."""
        return server_name in self._data

    def get_client_id(self, server_name: str) -> str | None:
        """Retrieve stored client_id from dynamic registration."""
        entry = self._data.get(server_name)
        if entry:
            return entry.get("client_id")
        return None

    def save_client_id(self, server_name: str, client_id: str) -> None:
        """Store a dynamically registered client_id."""
        entry = self._data.setdefault(server_name, {})
        entry["client_id"] = client_id
        self._persist()

    def _migrate_namespaced_keys(self) -> None:
        """Migrate old plugin-namespaced keys (e.g. 'engineering:slack') to
        plain connector IDs (e.g. 'slack').

        When multiple namespaced keys map to the same connector, keep the
        one with the most recent expiry.
        """
        migrated = False
        old_keys = [k for k in self._data if ":" in k]
        for old_key in old_keys:
            new_key = old_key.split(":", 1)[1]
            entry = self._data[old_key]

            if new_key not in self._data:
                self._data[new_key] = entry
            else:
                # Keep the one with the later expiry
                existing_expiry = self._data[new_key].get("expires_at", 0)
                new_expiry = entry.get("expires_at", 0)
                if new_expiry > existing_expiry:
                    self._data[new_key] = entry

            del self._data[old_key]
            migrated = True

        if migrated:
            logger.info("Migrated %d namespaced token key(s)", len(old_keys))
            self._persist()

    def _load(self) -> dict[str, dict[str, Any]]:
        if not self._path.is_file():
            return {}
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except (OSError, json.JSONDecodeError) as e:
            logger.warning("Cannot read MCP tokens: %s", e)
        return {}

    def _persist(self) -> None:
        try:
            with file_lock(self._path):
                atomic_write_text(self._path, json.dumps(self._data, indent=2))
        except OSError as e:
            logger.warning("Cannot persist MCP tokens: %s", e)
