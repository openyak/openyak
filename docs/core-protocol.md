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

// A session config option exactly as the agent advertises it over ACP (model, effort,
// mode, …). Core passes these through; it does not interpret them.
type AgentConfigOption =
  | { id: string; name: string; description?: string; category?: string;
      type: "select"; current_value: string;
      options: { value: string; name: string; description?: string; group?: string }[] }
  | { id: string; name: string; description?: string; category?: string;
      type: "boolean"; current_value: boolean }
  | { id: string; name: string; description?: string; category?: string; type: "unknown" };
```

`category` is the ACP category when given: `mode`, `model`, `model_config`,
`thought_level`, or an agent-specific string.

## Requests (app → core)

| method               | params                                                 | result             |
|----------------------|--------------------------------------------------------|--------------------|
| `agent.list`         | `{}`                                                   | `Agent[]`          |
| `project.list`       | `{}`                                                   | `Project[]`        |
| `project.create`     | `{ name: string, path: string }`                       | `Project`          |
| `task.list`          | `{ project_id }`                                       | `Task[]`           |
| `task.create`        | `{ project_id, title }`                                | `Task`             |
| `chat.history`       | `{ task_id }`                                          | `Message[]`        |
| `chat.send`          | `{ task_id, agent: AgentId, text }`                    | `{ user_message_id, assistant_message_id }` |
| `chat.cancel`        | `{ task_id }`                                          | `{}`               |
| `agent.connect`      | `{ task_id, agent: AgentId }`                          | `{}`               |
| `agent.set_config`   | `{ task_id, agent: AgentId, config_id: string, value: string \| boolean }` | `{}` |
| `permission.respond` | `{ request_id, option_id: string \| null }`            | `{}`               |

`chat.send` returns immediately; the assistant reply streams via notifications.

`agent.connect` starts the agent's adapter and session for the Task if they are not
running, so that `agent.config` arrives before the first prompt. It returns as soon as
the start is scheduled; readiness comes through `agent.status`.

`agent.set_config` forwards one option change to the running agent session
(ACP `session/set_config_option`, or `session/set_mode` for agents that only list
modes) and fails if the agent is not connected, rejects the value, or does not answer
within 30 s. Core remembers accepted values per `(task, agent)` and re-applies them
whenever it has to start a fresh session for that pair.

## Notifications (core → app)

| method          | params |
|-----------------|--------|
| `chat.update`   | `{ task_id, message_id, part_index: number, part: Part }` — upsert one part of the streaming assistant message. Text parts are sent whole (accumulated), not as deltas. |
| `chat.done`     | `{ task_id, message_id, status: "done" \| "error" \| "cancelled", error?: string }` |
| `agent.status`  | `{ task_id, agent: AgentId, state: "starting" \| "ready" \| "exited", detail?: string }` |
| `agent.config`  | `{ task_id, agent: AgentId, options: AgentConfigOption[] }` — the agent's session options and their current values. Sent when a session starts or resumes, after every accepted `agent.set_config`, and whenever the agent changes an option itself. Replaces any earlier list for the pair. |

## Requests (core → app)

| method               | params | result |
|----------------------|--------|--------|
| `permission.request` | `{ request_id, task_id, agent, title, options: { id, label, kind }[] }` | `{ option_id: string \| null }` (`null` = cancel) |

## Handoff semantics

Core owns the canonical transcript per Task. Each `(task, agent)` pair lazily gets its
own ACP session. When a prompt goes to an agent whose session has not seen the latest
messages (because another agent produced them), core prepends a handoff block
containing the missed turns, then records that the agent is now caught up.

Sessions do not outlive the agent process. When core has to start one for a pair it
first tries to resume the last session it recorded (ACP `session/load`); if the agent
cannot, it starts a fresh session and resets the pair's cursor, so the next prompt
carries the whole transcript. See `docs/architecture.md`.
