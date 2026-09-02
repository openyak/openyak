# OpenYak Context

OpenYak is a desktop workbench for driving coding agents: Project → Task → Chat. This
file is the canonical glossary. Use these terms exactly; avoid the listed aliases.

**Project**: A directory on disk that agents run in. _Avoid_: workspace, repo, folder.

**Task**: A bounded piece of work inside a Project. Owns exactly one Chat. _Avoid_:
session, thread, ticket.

**Chat**: The canonical, agent-neutral transcript of a Task, stored by core. _Avoid_:
conversation, session, thread.

**Message**: One turn in a Chat, authored by user or assistant, made of Parts. An
assistant Message records which Agent produced it. _Avoid_: turn, post.

**Part**: Atomic content unit in a Message — text, thought, tool call, error.
_Avoid_: block, chunk.

**Agent**: An external ACP adapter that serves a Chat (`claude`, `codex`). Chosen per
Message. _Avoid_: model, provider, assistant, bot.

**Agent session**: The ACP session core holds for one (Task, Agent) pair. Internal.
_Avoid_: exposing this in UI copy.

**Handoff**: The block of missed Chat turns core prepends when a Message goes to an Agent
that has not seen them. _Avoid_: summary, context transfer.

**Core**: The `openyak-core` Rust process: transcript store + ACP client. _Avoid_:
backend, server, daemon.

**App**: The Electron + React shell. _Avoid_: frontend, client, UI layer.
