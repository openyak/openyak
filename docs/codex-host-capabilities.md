# Codex desktop-host capability alignment

OpenYak uses two public, versioned interfaces instead of copying private Codex Desktop
implementation details:

- ACP (`@agentclientprotocol/codex-acp`) is the conversation transport. It carries
  prompts, tool calls, approvals, elicitation, file locations, config options, and
  `available_commands_update` events.
- Codex App Server is the desktop-host API. A separate management connection supplies
  `skills/list`, `skills/config/write`, `mcpServerStatus/list`, and `app/installed`
  to Settings.

The same installed Codex package and `$CODEX_HOME` back both connections. OpenYak does
not vendor plugin manifests, freeze skill contents, maintain a tool-name allowlist, or
restate the Codex system prompt.

## Renderer behavior

- Slash commands and `$skill` entries come from ACP command events and are stored by
  core with the Task. Typing `/` or `$` opens the active agent's current list.
- Completed ACP tool calls that declare edited files or resource links become artifact
  chips. The Electron host validates each path against the active Project before it can
  be previewed, opened, or revealed. Projectless chats use OpenYak's isolated
  projectless workspace as the root.
- Presentation-shaped results such as HTML, Markdown, PDF, and images open in the
  companion pane automatically; normal source edits stay compact in the transcript.
- Artifact previews use a scoped `openyak-artifact://` session. Relative HTML assets
  stay functional, while navigation cannot escape the Project root; the preview iframe
  remains sandboxed. Preview responses apply the documented Artifact network boundary:
  local/data assets plus the small public script/font CDN allowlist, with forms, nested
  frames, arbitrary connections, and object embeds blocked.
- Skill, MCP, and installed-app counts in Settings are live App Server results. Enabling
  or disabling a Skill uses `skills/config/write`.
- Tool disclosures render ACP content blocks and MCP `CallToolResult.content` directly,
  including images, audio, text, and resource links. No Computer Use or image-tool name
  allowlist is maintained.

## Upstream ownership

Codex Desktop-only behavior that has no App Server/ACP contract is not emulated. The
App Server currently marks `plugin/list`, `plugin/install`, and `plugin/uninstall` as
under development and explicitly excludes them from production clients, so OpenYak
does not expose them. New official Skills, MCP servers, apps, and tool output types flow
into OpenYak automatically when the bundled Codex dependency or user configuration changes.

Primary references:

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex plugins](https://learn.chatgpt.com/docs/plugins)
- [Codex skills](https://learn.chatgpt.com/docs/build-skills)
- [Computer Use](https://learn.chatgpt.com/docs/computer-use)
