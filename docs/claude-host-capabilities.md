# Claude desktop-host capability alignment

OpenYak uses the public surfaces shipped by `@agentclientprotocol/claude-agent-acp` and the
Claude Agent SDK. It does not copy Claude Desktop's private system prompt, embedded skills,
or internal MCP servers.

| Capability | OpenYak integration | Runtime authority |
|---|---|---|
| Claude Code system prompt | `_meta.systemPrompt = { type: "preset", preset: "claude_code", snapshot: true }` | Bundled Claude Code renders and snapshots the preset. OpenYak stores no prompt text. |
| Built-in tools | `claudeCode.options.tools = { type: "preset", preset: "claude_code" }` | Bundled Claude Code owns the tool set and changes it with its release. |
| Skills | `claudeCode.options.skills = "all"` | Claude Code discovers user, Project, local, plugin, and dynamically supplied skills. OpenYak stores no skill list. |
| Artifact | `claudeCode.options.settings.enableArtifact = true`; `emitRawSDKMessages = [{ type: "user" }]` | The SDK/account/policy decides whether the official tool is available. The public adapter forwards the structured user-side `tool_use_result`; core normalizes the public `ArtifactOutput` union into `artifact.*` events while retaining the raw event. No Artifact prompt, tool schema, or prose parser is maintained by OpenYak. |
| Chrome | `claudeCode.options.extraArgs.chrome = null` (the SDK representation of `--chrome`) | Claude Code and its official Chrome extension provide the browser tools and permissions. |
| AskUserQuestion | ACP form elicitation advertised at initialize and rendered from `requestedSchema` | `claude-agent-acp` exposes AskUserQuestion only when the client advertises form elicitation. |
| MCP elicitation | ACP form and URL elicitation | Agent/MCP server owns the schema; OpenYak returns the ACP action/content unchanged. |
| Host MCP servers | ACP `mcpServers` on both new and loaded sessions | The host profile supplies standard stdio/HTTP/SSE declarations; core has no server-name allowlist. |
| Computer Use built-in MCP | Not injected today | Anthropic's public documentation excludes non-interactive (`-p`/Agent SDK) sessions. OpenYak will use a public ACP/MCP endpoint when one exists instead of cloning a private Desktop service. |

The profile is centralized in `app/src/main/agent-host-profiles.ts`; core's generic transport is
in `core/src/agents.rs`, and the narrow public-SDK normalization boundary is
`core/src/artifacts.rs`. The renderer sees only the common `artifact.*` contract. This keeps
provider tool names and payload variants out of presentation code while still making the desktop
host responsible for capabilities it can actually serve.

Official references:

- [ACP initialization and client capabilities](https://agentclientprotocol.com/protocol/v1/initialization)
- [ACP session setup and MCP servers](https://agentclientprotocol.com/protocol/v1/session-setup)
- [Claude Agent SDK system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)
- [Claude Code features in the Agent SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features)
- [Claude Code Artifacts and surface availability](https://code.claude.com/docs/en/artifacts)
- [Claude Code in Chrome](https://code.claude.com/docs/en/chrome)
- [Computer Use limitations](https://code.claude.com/docs/en/computer-use)
