# Native Agent runtime

Implemented on `codex/native-agent-runtime`, based on OpenYak v2 `main`.

## Decision

OpenYak owns the GUI, lifecycle and canonical Chat, **not the agent loop**.
Use public structured interfaces to the real local agent engines:

```
App ⇄ Core (Chat, sessions, persistence)
       ├─ native worker ⇄ Codex App Server (stdio JSON-RPC)
       ├─ native worker ⇄ Claude Agent SDK ⇄ Claude Code CLI
       └─ ACP adapter (explicit compatibility mode)
```

Do not parse terminal escape sequences, tail private session files for control,
copy Desktop prompts/skills, clone provider tools, or reconstruct results from
Markdown. Claude's official SDK already drives its CLI: removing ACP does not
require reimplementing the SDK control protocol.

Public references: [Codex App Server](https://learn.chatgpt.com/docs/app-server),
[Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview).
The implementation uses installed public definitions for Codex `0.153.2` and
Claude Agent SDK `0.3.257`. Inspect the exact Codex wire contract with
`codex app-server generate-ts --out <temporary-directory>`.

## Runtime selection and ownership

App launches one native worker per `(Task, Agent)` by default, using Electron's
Node runtime. No global Node installation is required.

- `OPENYAK_AGENT_TRANSPORT=acp`: retained ACP behavior, after App restart.
- `OPENYAK_CODEX_BIN`: explicit Codex executable; otherwise the pinned official package.
- `OPENYAK_CLAUDE_BIN`: explicit CLI executable; otherwise the SDK-bundled Claude Code.
- Core `--runtimes`: per-Agent `{command,args,env}` launch map. Omitted Agents use ACP.
- `OPENYAK_DATA_DIR`: alternate App data directory for isolated desktop tests.

Explicit binary overrides require revalidating compatibility. These are alternative
transports, not simultaneous clients controlling one provider session. Native IDs
and Handoff cursors use a `:native-v1` namespace. First migration replays canonical
Chat into a new native session; it does not reuse opaque ACP adapter IDs. A saved
native session that cannot resume fails visibly, never silently starts fresh.
Native cursors advance only after successful completion. Failed or uncertain turns
remain eligible for the next Handoff instead of pretending their input was accepted.

## Implemented

- Codex: initialize, paginated model discovery, thread start/resume, streamed items,
  turn completion/interruption, model/reasoning/permission settings, skills discovery
  and explicit skill inputs, approval/requestUserInput responses, MCP elicitation,
  and native child-thread activity.
- Claude: long-lived SDK query, explicit session ID/resume, official `claude_code`
  presets, user/project/local settings, skills, model/effort/permission settings,
  canUseTool/AskUserQuestion, MCP elicitation, forwarded subagent messages and task events.
- Native and ACP Claude share existing host additions: Artifact setting, all skills,
  Chrome CLI option. Provider/account/extension/OS feature gates still apply.
- Structured Claude Artifact results enter Core's existing `artifact.*` normalizer.
  Codex file changes are file-change events, not invented official Artifacts.
- Original provider events are durable. Stable Part IDs reconcile streaming and final
  content. Provider-specific interpretation happens in drivers, never by tool-name
  guessing in the renderer. Unknown requests fail explicitly; unknown items are inspectable.
- App displays child-Agent status/activity details. Raw diagnostics are not displayed
  in the Chat; the paginated Core API remains available for debugging.
  Concurrent questions/approvals queue per Task; cancelled requests are removed.

## Host protocol

Core requests: `session.open`, `session.configure`, `turn.start`, `turn.cancel`.
Worker notifications: `runtime.part`, `runtime.event`, `runtime.config`.
Worker requests: `permission.request`, `elicitation.request` (correlated IDs).
Method-bearing frames are handled before response IDs; IDs can collide across directions.
Event envelopes carry schemaVersion, provider, epoch, monotonic sequence,
optional sourceSessionId and original data.

Raw envelopes live in SQLite `agent_events` as `provider.raw`, not Message JSON on
every token. `runtime.events` paginates them with an opaque cursor; `chat.events`
excludes them. Raw events can include prompts/tool output: they stay local and have
the same confidentiality requirements as Chat history.

Startup is bounded at 90 seconds, configuration at 25 seconds, cancellation at 15
seconds before closing an unresponsive session. EOF rejects pending requests,
closes approval UI, and fails active/queued Messages. Worker stdin EOF first gives
the SDK/App Server time to shut down its subprocesses.

## Boundaries — not 100% Desktop parity

This removes ACP translation loss, not private Desktop APIs, account gates or
interactive-only CLI boundaries. The following are not yet implemented:

- PTY terminal or native ↔ interactive CLI handover. Session ownership, active-turn
  transfer and permission equivalence require separate verification. No auto-fallback.
- Every CLI slash command, Desktop control, fast/collaboration-mode setting, async
  question variant or Claude dialog kind. Only implemented capabilities are advertised;
  other provider notifications remain in the raw log.
- Full Desktop workflow/phase UI or child control buttons. The initial child view
  shows reported IDs/parents/status/activity, not fabricated phases or token counts.
- Private transcript migration or arbitrary ACP-profile translation to SDK options.
  Native configuration comes from official runtime settings and shared host options.

## Verification

```
npm run check
cargo build --manifest-path core/Cargo.toml
npm run build -w app
node app/scripts/native-core-smoke.mjs fake
node app/scripts/native-core-smoke.mjs codex    # opt-in real inference
node app/scripts/native-runtime-smoke.mjs claude # opt-in real inference
node app/scripts/native-gui-smoke.mjs           # opt-in Electron + Playwright
node app/scripts/file-preview-gui-smoke.mjs     # isolated Electron file-preview regression
node app/scripts/file-preview-gui-smoke.mjs --live # also generate a real Codex report
```

Deterministic Core tests use an isolated temporary database/worker and cover send,
raw pagination, simultaneous questions, restart/resume, cursor isolation, cancellation
and process death. Driver tests cover duplex ID collisions, text reconciliation,
official question answers, unknown requests and child identities.

Live Codex passed two Messages across a Core restart. Claude completed startup and
configuration discovery but real inference hit the account session limit during
this run. Full live Claude/tool/multi-Agent parity is not claimed.

The initial Electron test passed a real Codex send, rendered completion and raw-log
loading with no renderer exceptions. The raw-log widget has since been removed from
Chat; the smoke test now asserts its absence. Explicit IPC fixtures verified two concurrent
questions, fresh form state on the second question, cancellation and a child-Agent
card. Those fixtures are not evidence of a live provider multi-Agent run. It uses
an isolated data directory and preserves a screenshot for visual inspection.

## Task-scoped file outputs

File resolve/inspect/open/reveal IPC accepts a Task ID, not a renderer-supplied root.
The main process queries `task.context`; Core shares its cwd resolver with agent execution.
This covers both project-bound and projectless Chats without duplicating a workspace path
in the frontend. Canonical-path containment still rejects traversal and escaping symlinks.

Successful structured Codex `fileChange` items, Claude `Write`/`Edit` tool results with
official tool metadata, and ACP `diff` content normalize in Core to:

```json
{"type":"event","kind":"file.output","data":{"schema_version":1,"tool_call_id":"write-id","files":[{"path":"report.md"}]}}
```

Original provider parts are retained. Terminal legacy history is enriched in memory,
idempotently, without rewriting the database or changing live part indices. Failures,
in-progress writes and deletions do not produce output cards. Shell output and response
prose are not interpreted as file-write evidence. Official `artifact.*` remains distinct;
both event families use the workbench. Presentation files auto-preview; source files
remain clickable without taking focus automatically. Closing a preview or switching
tasks does not reopen an already-presented output during the same app session.

The deterministic GUI regression covers a legacy projectless Chinese/space-encoded
report path, automatic and manual opening, Markdown rendering, nested file links,
syntax highlighting/line targets, HTML sandboxing, multiple tabs, task switching,
missing-file feedback and path/symlink denial. It never writes to the user's database.

## Approval presentation

Native Codex approvals normalize official decision variants into human-readable options
inside the runtime adapter, not the renderer. Option IDs still map to the original
decision values (including policy-amendment objects). `decline` rejects the operation
but permits the agent to continue; `cancel` interrupts the turn. Session-scoped grants
are never labeled permanent and persistent grants are never preselected. Unsupported
future decision variants are visible but disabled and cannot be submitted as grants.

Optional `PermissionRequest.details` carries command, working directory, reason,
network target, additional permission context, and file changes. File approvals join
the previously received item by `itemId`; missing diffs are reported as unavailable,
never reconstructed from assistant prose. The original `tool_call` remains intact.
ACP falls back to its structured diff/location/rawInput fields and keeps provider labels.

The shared permission card presents scoped radio choices and one Submit action, with
a separate cancel action and a duplicate-submit guard. Enter submits only inside the
form; Escape cancels only while focus is within it. Elicitation styling is unchanged.
`app/test/permission-preview.html` is an isolated Vite browser fixture using the actual
component and normalizer. Its callbacks only record decisions; no agent is invoked and
no permissions are changed. Unit tests separately verify native decision round trips.
