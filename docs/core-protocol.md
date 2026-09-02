# Core protocol (app ⇄ core)

The Electron main process spawns `openyak-core` and talks to it over **stdin/stdout,
newline-delimited JSON-RPC 2.0**. One JSON object per line. Core writes nothing else
to stdout; logs go to stderr.

Both directions are JSON-RPC 2.0: the app sends requests, core replies; core sends
notifications and one request (`permission.request`) that the app must answer.

## Identifiers

All ids are ULID strings. Timestamps are RFC 3339 UTC strings.

## Types

```ts
type AgentId = "claude" | "codex";          // more later

interface Agent   { id: AgentId; name: string; available: boolean; command: string }
interface Project { id: string; name: string; path: string; created_at: string }
interface Task    { id: string; project_id: string; title: string; created_at: string }
interface Message {
  id: string; task_id: string; role: "user" | "assistant";
  agent: AgentId | null;                   // which agent produced/received it
  parts: Part[]; created_at: string; status: "streaming" | "done" | "error" | "cancelled";
}
type Part =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool_call"; id: string; title: string; kind: string; status: string; output?: string }
  | { type: "error"; message: string };
```

## Requests (app → core)

| method            | params                                   | result             |
|-------------------|------------------------------------------|--------------------|
| `agent.list`      | `{}`                                     | `Agent[]`          |
| `project.list`    | `{}`                                     | `Project[]`        |
| `project.create`  | `{ name: string, path: string }`         | `Project`          |
| `task.list`       | `{ project_id }`                         | `Task[]`           |
| `task.create`     | `{ project_id, title }`                  | `Task`             |
| `chat.history`    | `{ task_id }`                            | `Message[]`        |
| `chat.send`       | `{ task_id, agent: AgentId, text }`      | `{ user_message_id, assistant_message_id }` |
| `chat.cancel`     | `{ task_id }`                            | `{}`               |
| `permission.respond` | `{ request_id, option_id: string \| null }` | `{}`         |

`chat.send` returns immediately; the assistant reply streams via notifications.

## Notifications (core → app)

| method          | params |
|-----------------|--------|
| `chat.update`   | `{ task_id, message_id, part_index: number, part: Part }` — upsert one part of the streaming assistant message. Text parts are sent whole (accumulated), not as deltas. |
| `chat.done`     | `{ task_id, message_id, status: "done" \| "error" \| "cancelled", error?: string }` |
| `agent.status`  | `{ task_id, agent: AgentId, state: "starting" \| "ready" \| "exited", detail?: string }` |

## Requests (core → app)

| method               | params | result |
|----------------------|--------|--------|
| `permission.request` | `{ request_id, task_id, agent, title, options: { id, label, kind }[] }` | `{ option_id: string \| null }` (`null` = cancel) |

## Handoff semantics

Core owns the canonical transcript per Task. Each `(task, agent)` pair lazily gets its
own ACP session. When `chat.send` targets an agent whose session has not seen the latest
messages (because another agent produced them), core prepends a handoff block to the
prompt containing the missed turns, then records that the agent is now caught up.
See `docs/architecture.md`.
