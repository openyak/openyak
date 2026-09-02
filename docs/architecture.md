# OpenYak v2 architecture

OpenYak v2 is a desktop workbench with one job: **Project → Task → Chat**, where the
Chat is served by whichever coding agent you pick, and you can switch agents mid-task
without losing the thread.

It does not implement an agent loop, tools, or model calls. It drives the coding agents
you already have installed (Claude Code, Codex, more later) through the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com).

## Processes

```
┌────────────────────────────┐   stdio NDJSON-RPC   ┌──────────────────┐   ACP over stdio   ┌──────────────────┐
│ app/  Electron + React     │ ───────────────────▶ │ core/  Rust      │ ─────────────────▶ │ claude-code-acp  │
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

## Switching agents without losing the thread

Every agent keeps its own context on its own side. OpenYak does not try to share it.
Instead core keeps the transcript and a per-`(task, agent)` cursor: the index of the last
Chat message that agent has seen.

When a message is sent to an agent:

1. If the agent has no session for this task, core creates one (ACP `session/new` in the
   Project directory).
2. Core collects Chat messages after the agent's cursor. If any exist (produced by another
   agent), it renders them as a **handoff block** and prepends it to the prompt:

   ```
   <handoff>
   You are continuing a task. Earlier turns were handled by another assistant.
   Treat them as the conversation so far.

   [user] …
   [assistant · codex] …
   </handoff>

   <actual user message>
   ```
3. Core advances the cursor to the end of the transcript, sends the ACP `session/prompt`,
   and streams `session/update` notifications back as `chat.update`.

Because the first prompt to a fresh session carries the whole prior transcript, and later
prompts carry only what the agent missed, switching back and forth stays coherent and
costs no more context than necessary.

Model choice inside an agent (Sonnet vs Opus, GPT-5 variants) rides on ACP session config
options and is a follow-up; the alpha switches agents only.

## Non-goals for v2

No built-in tools, no provider API keys, no Computer Use, no office document pipeline, no
plugins, no remote access. Anything an agent can do is the agent's job. Anything that is
not Project → Task → Chat is out of scope until the core loop is excellent.
