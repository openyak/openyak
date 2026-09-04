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

interface Agent   { id: AgentId; name: string; available: boolean; hint?: string; command: string }
interface Project { id: string; name: string; path: string; created_at: string }
interface Task    { id: string; project_id: string | null; title: string; created_at: string; updated_at: string;
                    message_count: number }   // 0 = a chat that has not started
interface Message {
  id: string; task_id: string; role: "user" | "assistant";
  agent: AgentId | null;                   // which agent produced/received it
  parts: Part[]; created_at: string; status: "streaming" | "done" | "error" | "cancelled";
  duration_ms?: number | null;             // wall-clock assistant response time; null for user/legacy messages
  stop_reason?: string | null;             // ACP StopReason of the reply: end_turn | max_tokens | max_turn_requests | refusal | cancelled
  usage?: unknown;                         // ACP PromptResponse.usage verbatim, when the agent reports it
}
type Part =
  | { type: "text"; text: string; _meta?: Record<string, unknown>; message_id?: string }
  | { type: "thought"; text: string; _meta?: Record<string, unknown>; message_id?: string }
  | { type: "tool_call"; id: string; title: string; kind: string; status: string;
      output?: string;                     // derived: the text content blocks joined, "diff <path>" for diffs (kept for compatibility)
      content?: unknown[];                 // ACP ToolCallContent[] verbatim (wire JSON: content | diff | terminal); replaced by an update that carries content
      locations?: unknown[];               // ACP ToolCallLocation[] verbatim
      raw_input?: unknown; raw_output?: unknown;   // ACP raw_input / raw_output verbatim
      _meta?: Record<string, unknown> }
  | { type: "error"; message: string }
  | { type: "event"; kind: string; data: unknown }   // any other ACP session update or extension notification, verbatim; see "Fidelity rule"
  | { type: "image"; mime_type: string; data: string }   // attachment on a user message, base64
  | { type: "file"; path: string; name: string };        // attachment on a user message, by path

// An ACP session update (or extension notification) that arrived while no reply was
// streaming for the (task, agent) pair, e.g. the slash-command list sent when a session
// opens. Stored by core, listed with `chat.events`, announced with `chat.event`.
interface AgentEvent { id: string; task_id: string; agent: AgentId; kind: string; data: unknown; created_at: string }

// What the app attaches to a message. Images become ACP image blocks; files and folders
// become `file://` resource links the agent can open itself.
type Attachment =
  | { type: "image"; mime_type: string; data: string }
  | { type: "file"; path: string };

// A session config option exactly as the agent advertises it over ACP (model, effort,
// mode, …). Core passes these through; it does not interpret them.
type AgentConfigOption =
  | { id: string; name: string; description?: string; category?: string;
      type: "select"; current_value: string;
      options: { value: string; name: string; description?: string; group?: string; kind?: string }[] }
  | { id: string; name: string; description?: string; category?: string;
      type: "boolean"; current_value: boolean }
  | { id: string; name: string; description?: string; category?: string; type: "unknown" };
```

`category` is the ACP category when given: `mode`, `model`, `model_config`,
`thought_level`, or an agent-specific string. `kind` on a select option is the hint some
agents attach to modes (`standard`, `auto_review`, `full_access`, `plan`); the app uses
it only for the mode pill's icon and colour.

## Requests (app → core)

| method               | params                                                 | result             |
|----------------------|--------------------------------------------------------|--------------------|
| `agent.list`         | `{}`                                                   | `Agent[]`          |
| `project.list`       | `{}`                                                   | `Project[]`        |
| `project.create`     | `{ name: string, path: string }`                       | `Project`          |
| `project.rename`     | `{ project_id, name }`                                 | `Project`          |
| `project.update`     | `{ project_id, name, path }`                           | `Project` — updates editable fields; changing the path restarts that project's agent sessions |
| `project.delete`     | `{ project_id }`                                       | `{}` — removes the Project and all of its Chats and agent sessions |
| `task.list`          | `{ project_id: string \| null }`                        | `Task[]` (most recently updated first) |
| `task.create`        | `{ project_id: string \| null, title }`                 | `Task`             |
| `task.rename`        | `{ task_id, title }`                                   | `Task`             |
| `task.delete`        | `{ task_id }`                                          | `{}` — removes the Chat and the task's agent sessions |
| `chat.history`       | `{ task_id }`                                          | `Message[]`        |
| `chat.events`        | `{ task_id }`                                          | `AgentEvent[]` (oldest first) — session updates that arrived outside a reply |
| `chat.send`          | `{ task_id, agent: AgentId, text, attachments?: Attachment[] }` | `{ user_message_id, assistant_message_id }` |
| `chat.edit`          | `{ task_id, message_id, agent: AgentId, text, attachments?: Attachment[] }` | `{ user_message_id, assistant_message_id }` |
| `chat.retry`         | `{ task_id, message_id, agent: AgentId }`              | `{ assistant_message_id }` |
| `chat.cancel`        | `{ task_id }`                                          | `{}`               |
| `agent.connect`      | `{ task_id, agent: AgentId }`                          | `{}`               |
| `agent.disconnect`   | `{ agent: AgentId }`                                   | `{}`               |
| `agent.set_config`   | `{ task_id, agent: AgentId, config_id: string, value: string \| boolean }` | `{}` |
| `permission.respond` | `{ request_id, option_id: string \| null }`            | `{}`               |

`chat.send` returns immediately; the assistant reply streams via notifications. A message
needs text or at least one attachment. Attachments are stored as `image` / `file` Parts of
the user message and sent to the agent as ACP content blocks after the text.

`chat.edit` rewinds the conversation to the selected user message, replaces that prompt
(including its attachments), and starts a fresh reply. `chat.retry` rewinds from the
selected assistant message and runs the preceding user prompt again without duplicating it.
Both operations require an idle chat, discard later transcript messages, preserve files on
disk, and start fresh agent sessions so discarded context cannot leak into the replay. Saved
model, effort, and permission-mode config is reapplied to those fresh sessions.

`agent.connect` starts the agent's adapter and session for the Task if they are not
running, so that `agent.config` arrives before the first prompt. It returns as soon as
the start is scheduled; readiness comes through `agent.status`. If the pair is already
running, core re-sends `agent.status` and `agent.config` so a freshly loaded app still
learns the session's options.

`agent.disconnect` stops every session for that provider across Tasks. OpenYak uses it
when the provider is disabled in Settings; later `agent.connect` calls can start it again.

`agent.set_config` forwards one option change to the running agent session
(ACP `session/set_config_option`, or `session/set_mode` for agents that only list
modes) and fails if the agent is not connected, rejects the value, or does not answer
within 30 s. Core remembers accepted values per `(task, agent)` and re-applies them
whenever it has to start a fresh session for that pair.

## Notifications (core → app)

| method          | params |
|-----------------|--------|
| `chat.update`   | `{ task_id, message_id, part_index: number, part: Part }` — upsert one part of the streaming assistant message. Text parts are sent whole (accumulated), not as deltas. `event` parts arrive the same way, in transport order. |
| `chat.done`     | `{ task_id, message_id, status: "done" \| "error" \| "cancelled", duration_ms: number, error?: string, stop_reason?: string, usage?: unknown, _meta?: Record<string, unknown> }` — `stop_reason` and `usage` are the ACP `PromptResponse` fields verbatim; `status` stays `done` for `max_tokens`, `max_turn_requests` and `refusal` so that only `stop_reason` distinguishes them. |
| `chat.event`    | `AgentEvent` — a session update that arrived while no reply was streaming for the pair. |
| `agent.status`  | `{ task_id, agent: AgentId, state: "starting" \| "ready" \| "exited", detail?: string }` |
| `agent.config`  | `{ task_id, agent: AgentId, options: AgentConfigOption[] }` — the agent's session options and their current values. A select value can carry `disabled: true` and `disabled_reason` when the agent advertised but definitively rejected it for this session. Sent when a session starts or resumes, after an accepted `agent.set_config`, after a definitive rejection, and whenever the agent changes an option itself. Replaces any earlier list for the pair. |

## Requests (core → app)

| method               | params | result |
|----------------------|--------|--------|
| `permission.request` | `{ request_id, task_id, agent, title, options: { id, label, kind, _meta? }[], tool_call: unknown, _meta?: Record<string, unknown> }` — `tool_call` is the ACP `ToolCallUpdate` of the request verbatim (title, kind, status, content incl. diffs, locations, rawInput, rawOutput, _meta); `_meta` is the request's own meta | `{ option_id: string \| null }` (`null` = cancel) |

## Fidelity rule

Core may leave something unrendered; it never discards it. Every ACP session update and
extension notification the agent sends is kept in one of two places:

- **During a reply** (a prompt is in flight for the pair): it becomes a Part of the
  streaming assistant message, in transport order. Text and thought chunks accumulate into
  `text` / `thought` parts; tool calls and their updates fold into one `tool_call` part per
  id with the ACP fields kept verbatim; a message or thought chunk whose content is not
  text (an image, a resource) and every other update kind (`plan`, `plan_update`,
  `plan_removed`, `usage_update`, `session_info_update`, `user_message_chunk`,
  `available_commands_update`, an extension notification such as `_claude/sdkMessage`)
  becomes an `event` part whose `kind` is the ACP `sessionUpdate` discriminator (or the
  extension method name) and whose `data` is the update object verbatim.
- **Outside a reply**: it is stored as an `AgentEvent` and announced with `chat.event`.
  The transcript an agent replays while core resumes its session with `session/load` is
  not stored again, because core already holds those turns as Messages; other updates
  that arrive during the load (the command list, usage) are stored.

Config and mode updates are applied to the session options and announced as
`agent.config` as before; they are not duplicated as events.

The streaming message is written to the store at every tool call or event and at most
every two seconds for text, so a core that exits mid-reply leaves the parts it had
received; on startup such a message is marked `cancelled` with its parts intact.

Tasks with no messages are drafts: the app creates one when a new chat starts (so the
agents' sessions and options exist before the first message), renames it on the first
message, and deletes it when the user leaves it unsent. Core purges leftover empty tasks
on startup.

## Handoff semantics

Core owns the canonical transcript per Task. Each `(task, agent)` pair lazily gets its
own ACP session. When a prompt goes to an agent whose session has not seen the latest
messages (because another agent produced them), core prepends a handoff block
containing the missed turns, then records that the agent is now caught up.

Sessions do not outlive the agent process. When core has to start one for a pair it
first tries to resume the last session it recorded (ACP `session/load`); if the agent
cannot, it starts a fresh session and resets the pair's cursor, so the next prompt
carries the whole transcript. See `docs/architecture.md`.
