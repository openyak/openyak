# OpenYak v2 architecture

> Native runtime update: Codex App Server and Claude Agent SDK are now the default
> conversation transports; ACP remains an explicit compatibility path. See
> [Native Agent runtime](native-agent-runtime.md) for the current topology, ownership,
> migration rules and verified limitations. ACP-specific sections below describe
> the retained compatibility implementation.

OpenYak v2 is a desktop workbench with one job: **Project → Task → Chat**, where the
Chat is served by whichever agent you pick, and you can switch agents mid-task
without losing the thread.

It does not implement an agent loop, tools, or model calls. It drives the agents
you already have installed (Claude Code, Codex, more later) through the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com).

## Processes

```
┌────────────────────────────┐   stdio NDJSON-RPC   ┌──────────────────┐   ACP over stdio   ┌──────────────────┐
│ app/  Electron + React     │ ───────────────────▶ │ core/  Rust      │ ─────────────────▶ │ claude-agent-acp │
│ Project · Task · Chat UI   │ ◀─────────────────── │ transcript store │ ◀───────────────── │ codex-acp        │
└────────────────────────────┘                      │ ACP client       │                    │ …                │
                                                    └──────────────────┘                    └──────────────────┘
```

- **app/** — Electron shell and React renderer. Renders projects, tasks, and the chat
  stream. Owns no agent logic. Talks only to core (`docs/core-protocol.md`).
- **core/** — `openyak-core`, a Rust binary. Owns the SQLite transcript store, spawns one
  ACP agent process per `(task, agent)` on demand, translates ACP session updates into
  `chat.update` notifications, and forwards permission and elicitation requests to the app.
- **agents** — ACP adapters bundled with the app and run with Electron's own Node:
  `@agentclientprotocol/claude-agent-acp` (on the official Claude Agent SDK, which ships
  Claude Code) and `@agentclientprotocol/codex-acp` (which ships Codex). The app hands
  core their launch commands via `--adapters`; core alone falls back to an adapter binary
  on `PATH`. They use the user's existing Claude Code and Codex sign-ins on this machine;
  OpenYak stores no provider credentials.

## Domain

- **Project** — a directory on disk. The working directory every agent session runs in.
- **Task** — a bounded piece of work inside a Project. Owns exactly one Chat.
- **Chat** — the canonical, agent-neutral transcript of a Task. Stored by core.
- **Agent** — an ACP adapter (`claude`, `codex`). Selected per message, not per Task.
- **Agent session** — the ACP session core holds for one `(Task, Agent)` pair. An
  implementation detail of continuity; never shown as a user-facing concept.

## What stays thin

The app is a chat interface, a transcript store, an ACP client, and a desktop capability
host. It does not reimplement an agent loop or copy provider prompt/skill contents. Core
passes an ACP-native session profile (`mcpServers` and opaque `_meta`) from the desktop
host to both `session/new` and `session/load`. Provider-specific public SDK options live
only at that host boundary; core does not interpret them.

When Codex or Claude Code asks for permission or input, core forwards the exact request
to the app and the user's answer straight back. OpenYak keeps no allowlist and makes no
safety decision of its own. Form elicitation is rendered from the agent's ACP JSON Schema,
not from provider-specific field names. Likewise the options an agent exposes for its session
(model, reasoning effort, permission mode, …) are shown as the agent advertises them
over ACP and the user's choice is passed back untouched.

## Switching agents without losing the thread

Every agent keeps its own context on its own side. OpenYak does not try to share it.
Instead core keeps the transcript and a per-`(task, agent)` cursor: the index of the last
Chat message that agent has seen.

When a message is sent to an agent:

1. If the agent has no session for this task, core opens one. It first tries to resume
   the session it last recorded for the pair (ACP `session/load`); if the agent cannot,
   it starts a fresh session (`session/new` in the Project directory) and resets the
   cursor to "seen nothing", since a fresh session has no memory of the Chat.
2. Core collects Chat messages after the agent's cursor. If any exist (produced by another
   agent, or by this agent before a restart it could not resume from), it renders them
   as a **handoff block** and prepends it to the prompt:

   ```
   <handoff>
   You are continuing a task. Earlier turns were handled by another assistant.
   Treat them as the conversation so far.

   [user] …
   [assistant · codex] …
   </handoff>

   <actual user message>
   ```
3. Core advances the cursor to the prompt, sends the ACP `session/prompt`, and streams
   `session/update` notifications back as `chat.update`. When the reply finishes the
   cursor moves past it.

Because the first prompt to a fresh session carries the whole prior transcript, and later
prompts carry only what the agent missed, switching back and forth stays coherent and
costs no more context than necessary.

The prompt is assembled by the agent connection at send time, not when the app calls
`chat.send`, so that it always reflects the session it actually goes to.

## Session options

An ACP session advertises config options (Codex: model, reasoning effort, approval
mode, collaboration mode, fast mode; Claude Code: model, effort, permission mode, fast
mode). Core captures them when the session opens, announces them to the app as
`agent.config`, and applies the app's `agent.set_config` through
`session/set_config_option` (or `session/set_mode` for agents that only list modes).
Accepted values are remembered per `(task, agent)` and re-applied whenever core has to
start a fresh session for that pair, so a model picked for a task survives a restart.
The app opens the agent's session as soon as it is selected (`agent.connect`) so the
options are visible before the first prompt.

## Host capabilities

The Claude profile selects the public `claude_code` system/tool presets, enables all
discovered skills, requests the SDK's Artifact feature, and forwards the public `--chrome`
flag. This keeps prompt text, tool definitions, skill contents, account gates, and feature
rollouts owned by the bundled Claude Code/Agent SDK. See
[`docs/claude-host-capabilities.md`](claude-host-capabilities.md).

Standard ACP MCP server declarations can be added to a host profile without changing core.
OpenYak does not copy Claude Desktop private resources or pretend to advertise a capability
it cannot serve.

Codex conversations continue to use ACP, while the Electron host uses the public Codex
App Server for the Desktop layer that ACP does not model: plugin inventory/installation,
Skills configuration, MCP status, and app discovery. Both are backed by the same bundled
Codex package and user configuration. The renderer builds its command palette from ACP
`available_commands_update` events. For Artifacts, the Claude host asks the official adapter to
forward only structured SDK user/tool-result messages; core normalizes the public
`ArtifactOutput` at the adapter ingress boundary into provider-neutral `artifact.*` Parts. The
renderer consumes only that contract and never guesses from tool names, file locations, prose,
or code fences. See
[`docs/claude-host-capabilities.md`](claude-host-capabilities.md) and
[`docs/codex-host-capabilities.md`](codex-host-capabilities.md).

## Non-goals for v2

No independently implemented agent loop, provider API-key store, provider tool clones,
private Desktop API reverse engineering, office document pipeline, remote access,
permission engine, or automatic routing between agents. Unsupported upstream capabilities
remain unavailable until there is a public SDK, ACP, or MCP integration point.
