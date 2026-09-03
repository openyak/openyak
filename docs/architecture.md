# OpenYak v2 architecture

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
  `chat.update` notifications, and forwards permission requests to the app.
- **agents** — external ACP adapters resolved from `PATH` or run through `npx`:
  `@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`. They use the user's
  existing Claude Code and Codex logins; OpenYak stores no provider credentials.

## Domain

- **Project** — a directory on disk. The working directory every agent session runs in.
- **Task** — a bounded piece of work inside a Project. Owns exactly one Chat.
- **Chat** — the canonical, agent-neutral transcript of a Task. Stored by core.
- **Agent** — an ACP adapter (`claude`, `codex`). Selected per message, not per Task.
- **Agent session** — the ACP session core holds for one `(Task, Agent)` pair. An
  implementation detail of continuity; never shown as a user-facing concept.

## What stays thin

The app is a chat interface, a transcript store, and an ACP client. Everything else is
the agent's: its tools, shell, file access, permissions, sandboxing, agent loop, and
login. When Codex or Claude Code asks for permission, core forwards that exact request
to the app and the user's answer straight back; OpenYak keeps no allowlist and makes no
safety decision of its own. Likewise the options an agent exposes for its session
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

## Non-goals for v2

No built-in tools, no provider API keys, no Computer Use, no office document pipeline, no
plugins, no remote access, no permission engine, no automatic routing between agents.
Anything an agent can do is the agent's job. Anything that is not Project → Task → Chat
is out of scope until the core loop is excellent.
