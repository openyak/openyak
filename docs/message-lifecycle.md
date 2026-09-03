# Message lifecycle

OpenYak gives Claude Code and Codex the same message controls even though their native
clients label some of them differently. This document is the product contract and manual
regression checklist for the shared chat UI.

## Operations

| State | User action | Result |
|---|---|---|
| Idle | Send text or attachments | The user turn and working placeholder appear immediately; failures restore the draft. |
| Working | Stop button or `Esc` | The active turn is cancelled, partial output is kept, and pending permission UI is dismissed. |
| Working | Type a correction and press `Enter` | The correction is queued, the active turn is interrupted, then the correction runs in the same task. |
| Stopped | Continue | A visible follow-up asks the same agent to continue from the stopped output. |
| Done, stopped, or failed | Retry latest response | The assistant response is replaced without duplicating the user prompt. |
| Idle | Edit any user message | The composer is populated with its text and attachments. Sending replaces that turn and every later transcript turn. Workspace files are not reverted. |
| Editing | Add, remove, or replace attachments | The revised attachment set is sent with the edited prompt. Duplicate and unreadable attachments are reported. |
| Editing | `Esc` or close | Editing is cancelled without changing the transcript. |
| App restart or task reopen | Resume | Core loads the saved native agent session when supported; otherwise it starts a fresh session and hands over the canonical transcript. |

## Replay invariants

- Editing and retrying are available only while the task is idle.
- Replaying clears native session ids and transcript cursors so discarded conversation
  cannot leak into the new answer.
- Model, effort, mode, and other saved agent config survive replay and are reapplied.
- Retry is enabled only for the latest assistant response. Replaying an older point starts
  from Edit, where the destructive transcript boundary is visible before sending.
- Conversation rewind never changes files in the selected project. File rollback is a
  separate source-control operation and is not implied by message editing.

## Visual and accessibility checks

- All icon-only controls have labels and visible focus states.
- Working, stopping, stopped, failed, and editing are distinguishable without relying on
  color alone.
- Message actions are visible on keyboard focus and on touch devices, not only on hover.
- Streaming follows the live edge until the reader scrolls up; a jump-to-latest control
  returns to the active response.
- Reduced-motion preferences disable shimmer, pulse, scrolling, and press animations.
