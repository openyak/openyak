# OpenYak Context

OpenYak is a local desktop AI workbench for office workflows: turning files, threads, and messy office context into deliverables. This file is the canonical glossary for the domain — names used across `backend/`, `frontend/`, and `desktop-tauri/`. Use these terms exactly; treat the listed aliases as words to avoid.

## Language

### Conversation core

**Session**:
A single ongoing conversation between a user and an Agent, scoped to a Workspace.
_Avoid_: chat, thread, dialogue.

**Message**:
A single turn in a Session, authored by either user or assistant.
_Avoid_: turn, post, entry.

**Part**:
The atomic content unit inside a Message — text, reasoning, tool call, step-finish, compaction, subtask, or file. Messages are sequences of Parts, not flat strings.
_Avoid_: block, segment, chunk.

**Compaction**:
A persistent Part that records summarization and dropped history when the context window is trimmed; the trim is a stored event, not an ephemeral pass.
_Avoid_: summary, trim, prune.

### Workspace & persistence

**Workspace**:
A user-bound directory plus its conversational state — where Tools read and write files and where Sessions accumulate. The runtime concept; the persisted record is a Project.
_Avoid_: folder, repo, directory.

**Project**:
The ORM record (`backend/app/models/project.py`) that persists a Workspace's path and metadata. One Project = one Workspace.
_Avoid_: workspace-record (use Project for the row, Workspace for the live concept).

**WorkspaceMemory**:
Long-term notes scoped to a single Workspace, surfaced into the Agent's system prompt across Sessions.
_Avoid_: knowledge base, memory.

### AI runtime

**Agent**:
A configuration bundle (system prompt, model choice, Tool allowlist, PermissionRules) that defines how a Session behaves.
_Avoid_: persona, assistant, bot.

**Provider**:
A pluggable backend that produces model output (OpenAI, Anthropic, Ollama, etc.); implements `BaseProvider` in `backend/app/provider/base.py`.
_Avoid_: model, backend, vendor.

**Tool**:
A named atomic action the Agent can execute (bash, edit, read, artifact, etc.); implements `ToolDefinition` in `backend/app/tool/base.py`.
_Avoid_: function, action, capability.

**ToolContext**:
The bundle of Workspace, Session, and permission state passed to a Tool when it executes; Tools never read globals, they read ToolContext.

**PermissionRule**:
A declarative rule that gates a Tool by name or regex match (`backend/app/agent/permission.py`); evaluated before the Tool runs, with a user prompt on miss.
_Avoid_: ACL, gate, policy.

**Skill**:
A lightweight composed routine — a named preset, smaller than an Agent and larger than a Tool ("a way to do X with these Tools and prompt").
_Avoid_: workflow, recipe, automation.

### Streaming & output

**GenerationJob**:
A single streaming model generation, with a stream id, an in-memory event replay buffer, and an abort signal; resumable via Last-Event-ID.
_Avoid_: stream, request, run.

**Artifact**:
A reusable, full-document Part rendered in the right-side panel — briefs, tables, plans, diagrams; distinct from inline code blocks.
_Avoid_: document, output, deliverable.

### Integration

**Channel**:
A non-OpenYak surface (Slack, Discord, Telegram, Feishu, WeChat, Email, etc.) that injects Messages into a Session and forwards Parts back out; implements `BaseChannel` in `backend/app/channels/base.py`.
_Avoid_: integration, connector, bot.

## Relationships

- A **Project** owns one **Workspace**; **Sessions** live inside a **Workspace**.
- A **Session** is a sequence of **Messages**; each **Message** is a sequence of **Parts**.
- An **Agent** drives a **Session** by calling a **Provider** and dispatching **Tools** through a **ToolContext**.
- A **PermissionRule** belongs to an **Agent** and gates the **Tools** it may invoke.
- A **GenerationJob** produces the **Parts** of a single assistant **Message**, streamed via SSE.
- An **Artifact** is a specific **Part** type; **Compaction** is another.
- A **Channel** delivers external **Messages** into a **Session** and ships the resulting **Parts** back out.
- **WorkspaceMemory** is read by an **Agent** at the start of every **Session** in that **Workspace**.

## Example dialogue

> **Dev:** "When the user attaches a deck and asks for a brief, do we store the deck inside the Session?"
> **Domain expert:** "No — the deck lives in the Workspace as a file. The Session's Message gets a `file` Part that points to it. The Agent reads it through a Tool that takes the path from its ToolContext."

> **Dev:** "If a long Session hits the context window, do we just drop old Messages?"
> **Domain expert:** "We materialize a Compaction Part — it records what was summarized, the user can see the trim happened, and the Session stays linear."

## Flagged ambiguities

- **Workspace vs. Project** — used interchangeably in places (e.g. `tool/workspace.py` vs. `models/project.py`). Resolved: **Project** is the persisted row; **Workspace** is the live, in-memory binding. Don't say "the Project's workspace"; say "the Workspace" or "the Project record."
- **Agent vs. Skill vs. Tool** — three scales of "a thing the AI does." Resolved: **Tool** = atomic action, **Skill** = composed routine of Tools+prompt, **Agent** = whole config that owns Skills, Tools, and permissions. Reach for the smallest term that fits.
- **Artifact vs. Part** — every Artifact is a Part; not every Part is an Artifact. Resolved: say **Part** unless the right-panel rendering specifically matters; then say **Artifact**.
- **Channel vs. Provider** — both are pluggable adapters. Resolved: a **Provider** generates content (LLM); a **Channel** delivers Messages to and from external surfaces. Never call Slack a Provider.
