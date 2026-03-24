"""ConnectorRegistry — manages deduplicated MCP server connections.

Wraps McpManager (composition) and adds:
- Deduplication by URL for remote servers, by name for local
- Independent enable/disable per connector
- Custom connector CRUD
- Persistence of user state (enabled set + custom connectors)
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from app.connector.model import ConnectorInfo
from app.mcp.manager import McpManager
from app.mcp.tool_wrapper import McpToolWrapper
from app.tool.base import ToolDefinition

logger = logging.getLogger(__name__)


class ConnectorRegistry:
    """Single source of truth for all MCP connector state."""

    def __init__(self, project_dir: str | None = None) -> None:
        self._connectors: dict[str, ConnectorInfo] = {}
        self._mcp_manager: McpManager | None = None
        self._tool_registry: Any | None = None  # set via set_tool_registry()
        self._project_dir = project_dir

        # Persistence paths
        if project_dir:
            self._state_path = Path(project_dir).resolve() / ".openyak" / "connectors.json"
        else:
            self._state_path = Path.home() / ".openyak" / "connectors.json"

        self._persisted_state = self._load_state()

        # Load static catalog (enriched metadata for known connectors)
        self._catalog = self._load_catalog()

    # ------------------------------------------------------------------
    # Registration (called during startup)
    # ------------------------------------------------------------------

    def register_from_plugin(
        self,
        plugin_name: str,
        mcp_servers: dict[str, dict[str, Any]],
    ) -> list[str]:
        """Extract unique connectors from a plugin's MCP config.

        Deduplicates remote servers by URL, local servers by name.
        Returns the list of connector IDs this plugin references.
        """
        connector_ids: list[str] = []

        for raw_key, config in mcp_servers.items():
            if not isinstance(config, dict):
                continue

            # Strip plugin namespace if present (e.g. "engineering:slack" → "slack")
            if ":" in raw_key:
                connector_id = raw_key.split(":", 1)[1]
            else:
                connector_id = raw_key

            url = config.get("url", "")
            server_type = config.get("type", "remote")

            # Skip entries with no URL for remote servers
            if server_type == "remote" and not url:
                continue

            # Check if this connector already exists (dedup)
            existing = self._find_by_url(url) if url else self._connectors.get(connector_id)

            if existing:
                # Add plugin reference if not already there
                if plugin_name not in existing.referenced_by:
                    existing.referenced_by.append(plugin_name)
                connector_ids.append(existing.id)
                continue

            # Create new connector, enriched with catalog metadata
            catalog_entry = self._catalog.get(connector_id, {})

            connector = ConnectorInfo(
                id=connector_id,
                name=catalog_entry.get("name", connector_id.replace("-", " ").title()),
                url=url,
                type=server_type,
                description=catalog_entry.get(
                    "description",
                    f"{connector_id.replace('-', ' ').title()} integration",
                ),
                category=catalog_entry.get("category", "other"),
                enabled=connector_id in self._persisted_state.get("enabled", []),
                source="builtin",
                local_config=(
                    {
                        k: v
                        for k, v in config.items()
                        if k not in ("type", "url", "enabled")
                    }
                    if server_type == "local"
                    else {}
                ),
                referenced_by=[plugin_name],
            )

            self._connectors[connector_id] = connector
            connector_ids.append(connector_id)

        return connector_ids

    def register_custom(
        self,
        id: str,
        name: str,
        url: str,
        description: str = "",
        category: str = "custom",
    ) -> ConnectorInfo:
        """Add a user-defined custom connector."""
        if id in self._connectors:
            raise ValueError(f"Connector '{id}' already exists")

        connector = ConnectorInfo(
            id=id,
            name=name,
            url=url,
            type="remote",
            description=description or f"{name} (custom connector)",
            category=category,
            enabled=False,
            source="custom",
        )
        self._connectors[id] = connector

        # Persist custom connector
        customs = self._persisted_state.setdefault("custom", [])
        customs.append({
            "id": id,
            "name": name,
            "url": url,
            "description": description,
            "category": category,
        })
        self._persist_state()

        return connector

    def remove_custom(self, id: str) -> bool:
        """Remove a custom connector. Returns False if not found or not custom."""
        connector = self._connectors.get(id)
        if not connector or connector.source != "custom":
            return False

        del self._connectors[id]

        # Remove from persisted custom list
        customs = self._persisted_state.get("custom", [])
        self._persisted_state["custom"] = [c for c in customs if c.get("id") != id]
        self._persisted_state.get("enabled", [])
        if id in self._persisted_state.get("enabled", []):
            self._persisted_state["enabled"].remove(id)
        self._persist_state()

        return True

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def startup(self) -> None:
        """Build McpManager config from enabled connectors and start connections."""
        # Restore custom connectors from persisted state
        for custom in self._persisted_state.get("custom", []):
            cid = custom.get("id", "")
            if cid and cid not in self._connectors:
                self._connectors[cid] = ConnectorInfo(
                    id=cid,
                    name=custom.get("name", cid),
                    url=custom.get("url", ""),
                    type="remote",
                    description=custom.get("description", ""),
                    category=custom.get("category", "custom"),
                    enabled=cid in self._persisted_state.get("enabled", []),
                    source="custom",
                )

        # Inject credentials into local connectors that need them
        self._inject_local_credentials()

        # Build MCP config dict from all connectors (enabled or not)
        mcp_config: dict[str, Any] = {}
        for cid, connector in self._connectors.items():
            if connector.type == "local":
                mcp_config[cid] = {
                    "type": "local",
                    "enabled": connector.enabled,
                    **connector.local_config,
                }
            else:
                mcp_config[cid] = {
                    "type": "remote",
                    "url": connector.url,
                    "enabled": connector.enabled,
                }

        self._mcp_manager = McpManager(mcp_config, project_dir=self._project_dir)
        await self._mcp_manager.startup()

        logger.info(
            "ConnectorRegistry: %d connectors (%d enabled)",
            len(self._connectors),
            sum(1 for c in self._connectors.values() if c.enabled),
        )

    async def shutdown(self) -> None:
        """Disconnect all MCP servers."""
        if self._mcp_manager:
            await self._mcp_manager.shutdown()

    # ------------------------------------------------------------------
    # CRUD / state
    # ------------------------------------------------------------------

    def list_connectors(self) -> list[ConnectorInfo]:
        """Return all connectors sorted by name."""
        return sorted(self._connectors.values(), key=lambda c: c.name)

    def get(self, id: str) -> ConnectorInfo | None:
        """Get a single connector by ID."""
        return self._connectors.get(id)

    async def enable(self, id: str) -> bool:
        """Enable a connector and attempt to connect it."""
        connector = self._connectors.get(id)
        if not connector or connector.enabled:
            return False

        connector.enabled = True
        enabled = self._persisted_state.setdefault("enabled", [])
        if id not in enabled:
            enabled.append(id)
        self._persist_state()
        logger.info("Connector enabled: %s", id)

        # Actually connect the MCP server
        if self._mcp_manager:
            try:
                await self._mcp_manager.reconnect(id)
            except Exception as e:
                logger.warning("Failed to connect '%s' after enable: %s", id, e)
            self.sync_tools()

        return True

    async def disable(self, id: str) -> bool:
        """Disable a connector and disconnect it."""
        connector = self._connectors.get(id)
        if not connector or not connector.enabled:
            return False

        connector.enabled = False
        enabled = self._persisted_state.get("enabled", [])
        if id in enabled:
            enabled.remove(id)
        self._persist_state()
        logger.info("Connector disabled: %s", id)

        # Disconnect the MCP server
        if self._mcp_manager:
            client = self._mcp_manager._clients.get(id)
            if client:
                try:
                    await client.close()
                    client.status = "disabled"
                    client.error = None
                except Exception as e:
                    logger.warning("Failed to disconnect '%s' after disable: %s", id, e)
            self.sync_tools()

        return True

    async def connect(self, id: str, redirect_uri: str) -> dict[str, str] | None:
        """Start OAuth flow for a connector. Returns auth URL info or None."""
        if not self._mcp_manager:
            return None
        return await self._mcp_manager.start_auth(id, redirect_uri)

    async def complete_auth(self, state: str, code: str) -> bool:
        """Complete OAuth flow with auth code."""
        if not self._mcp_manager:
            return False
        result = await self._mcp_manager.complete_auth(state, code)
        if result:
            self.sync_tools()
        return result

    async def disconnect(self, id: str) -> bool:
        """Revoke OAuth tokens and disconnect."""
        if not self._mcp_manager:
            return False
        result = await self._mcp_manager.disconnect_auth(id)
        self.sync_tools()
        return result

    async def reconnect(self, id: str) -> bool:
        """Reconnect a specific connector."""
        if not self._mcp_manager:
            return False
        result = await self._mcp_manager.reconnect(id)
        self.sync_tools()
        return result

    # ------------------------------------------------------------------
    # Tool registry integration
    # ------------------------------------------------------------------

    def set_tool_registry(self, registry: Any) -> None:
        """Bind a ToolRegistry so MCP tool changes are synced automatically."""
        self._tool_registry = registry

    def sync_tools(self) -> None:
        """Synchronise MCP tools in the ToolRegistry with current connections.

        Removes stale MCP tools and adds newly available ones.
        Called automatically after enable/disable/connect/disconnect.
        """
        if not self._tool_registry:
            return

        # Remove all existing MCP tools (they start with a connector id prefix)
        existing_ids = [
            tid for tid, tool in list(self._tool_registry._tools.items())
            if isinstance(tool, McpToolWrapper)
        ]
        for tid in existing_ids:
            self._tool_registry.unregister(tid)

        # Re-add tools from currently connected servers
        for tool in self.tools():
            self._tool_registry.register(tool)

        logger.info(
            "MCP tools synced: %d tools from connected servers",
            len(self.tools()),
        )

    # ------------------------------------------------------------------
    # Tool / status access (delegates to McpManager)
    # ------------------------------------------------------------------

    def tools(self) -> list[ToolDefinition]:
        """Get all tools from connected MCP servers."""
        if not self._mcp_manager:
            return []
        return self._mcp_manager.tools()

    def status(self) -> dict[str, dict[str, Any]]:
        """Return connection status of all connectors.

        Merges McpManager runtime status with ConnectorInfo metadata.
        """
        mcp_status = self._mcp_manager.status() if self._mcp_manager else {}

        result: dict[str, dict[str, Any]] = {}
        for cid, connector in self._connectors.items():
            runtime = mcp_status.get(cid, {})
            mcp_connected = runtime.get("status") == "connected"
            effective_status = runtime.get("status", "disabled" if not connector.enabled else "disconnected")

            # Google Workspace: MCP server can start without OAuth tokens.
            # Override status to "needs_auth" if user hasn't completed Google login.
            if cid == "google-workspace" and mcp_connected:
                from app.api.google_auth import load_google_tokens
                tokens = load_google_tokens(self._project_dir)
                if not tokens or not tokens.get("refresh_token"):
                    mcp_connected = False
                    effective_status = "needs_auth"

            result[cid] = {
                **connector.to_dict(),
                "connected": mcp_connected,
                "status": effective_status,
                "error": runtime.get("error"),
                "tools_count": runtime.get("tools", 0),
            }

        return result

    @property
    def mcp_manager(self) -> McpManager | None:
        """Access the underlying McpManager (for backward compatibility)."""
        return self._mcp_manager

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _inject_local_credentials(self) -> None:
        """Inject stored credentials into local connectors as environment vars.

        google-workspace-mcp expects:
          GOOGLE_WORKSPACE_CLIENT_ID
          GOOGLE_WORKSPACE_CLIENT_SECRET
          GOOGLE_WORKSPACE_REFRESH_TOKEN
        """
        gw = self._connectors.get("google-workspace")
        if not gw or gw.type != "local":
            return

        try:
            from app.config import get_settings
            settings = get_settings()
            client_id = settings.google_client_id
            client_secret = settings.google_client_secret
        except Exception:
            return

        if not client_id:
            return

        from app.api.google_auth import load_google_tokens
        tokens = load_google_tokens(self._project_dir)

        env = gw.local_config.setdefault("environment", {})
        env["GOOGLE_WORKSPACE_CLIENT_ID"] = client_id
        env["GOOGLE_WORKSPACE_CLIENT_SECRET"] = client_secret

        if tokens and tokens.get("refresh_token"):
            env["GOOGLE_WORKSPACE_REFRESH_TOKEN"] = tokens["refresh_token"]

    def _find_by_url(self, url: str) -> ConnectorInfo | None:
        """Find a connector by URL (for dedup)."""
        if not url:
            return None
        normalized = self._normalize_url(url)
        for connector in self._connectors.values():
            if self._normalize_url(connector.url) == normalized:
                return connector
        return None

    @staticmethod
    def _normalize_url(url: str) -> str:
        """Normalize URL for deduplication comparison."""
        parsed = urlparse(url)
        # Strip trailing slashes, lowercase host
        path = parsed.path.rstrip("/")
        return f"{parsed.scheme}://{parsed.netloc.lower()}{path}"

    def _load_catalog(self) -> dict[str, dict[str, Any]]:
        """Load the static connector catalog with enriched metadata."""
        catalog_path = Path(__file__).parent.parent / "data" / "connectors.json"
        if not catalog_path.is_file():
            return {}
        try:
            data = json.loads(catalog_path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError) as e:
            logger.warning("Cannot read connector catalog: %s", e)
            return {}

    def _load_state(self) -> dict[str, Any]:
        """Load persisted user state (enabled set + custom connectors)."""
        if not self._state_path.is_file():
            return {"enabled": [], "custom": []}
        try:
            data = json.loads(self._state_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except (OSError, json.JSONDecodeError) as e:
            logger.warning("Cannot read connector state: %s", e)
        return {"enabled": [], "custom": []}

    def _persist_state(self) -> None:
        """Save user state to disk."""
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            self._state_path.write_text(
                json.dumps(self._persisted_state, indent=2),
                encoding="utf-8",
            )
        except OSError as e:
            logger.warning("Cannot persist connector state: %s", e)
