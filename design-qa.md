# Design QA — Codex-aligned Work Mode

Date: 2026-07-23

## Result

OpenYak now matches the supplied local Codex / ChatGPT Work Mode references in task-shell hierarchy, wide-screen transcript placement, Summary behavior, lifecycle disclosure, Subagents density, child-detail structure, and Composer control grouping. The remaining product-specific differences are intentional: OpenYak keeps its project/workspace system and does not copy agent avatars, proprietary icons, Mac window controls, or decorative-only features.

The final conversation pass also closes the remaining execution-narrative gap:
tool work, Agent coordination, compaction, prose, and follow-up work now stay in
their real execution order instead of being hoisted into a generic completed
card. The visible result is the same restrained Work Mode grammar used by the
reference: compact activity rows, inline Agent pills with an adjacent lifecycle
label, bright readable prose, quiet persistent message actions, and a stable
Composer.

The parent-task Summary now also closes the provenance gap that is easy to miss
in screenshot-only matching. Outputs and Sources are aggregated from valid
direct and nested descendants, deduplicated without dropping their producer
lineage, and updated from the same live Subagents query. Real connector results
are supported whether their structured records are persisted in tool metadata
or in a JSON object/list from an explicit web/MCP connector tool. Large connector results are
reduced to a compact, versioned `source_evidence` envelope before the normal
50 KiB / 2,000-line output truncation, so Sources survive persistence and later
compaction without copying the raw payload into SSE or the database. Ordinary
prose and local Read/Bash/Code JSON are never scanned for guessed URLs. A valid
`source_evidence` envelope is authoritative even when empty, and only
credential-free HTTP(S) links without secret query/path values become
interactive. Title and snippet credential assignments are redacted before
persistence and again at the rendering boundary.

## Reference and implementation evidence

- Codex Work Mode reference: `/var/folders/73/g_zg7t154b9_jk2kx3dr9r1h0000gn/T/codex-clipboard-b9cb14ac-87d8-4bfd-9e10-851dacccb264.png`
- Codex Subagents reference: `/var/folders/73/g_zg7t154b9_jk2kx3dr9r1h0000gn/T/codex-clipboard-d0403ba1-bf4c-43fc-a352-386e48d20021.png`
- OpenYak parent-task capture: `/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/08-openyak-work-mode-parent-final.png`
- OpenYak Subagents capture: `/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/09-openyak-subagents-final.png`
- OpenYak child-detail capture: `/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/10-openyak-subagent-detail-final.png`
- Same-viewport Work Mode comparison: `/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/11-codex-openyak-work-mode-final-comparison.png`
- Same-viewport Subagents comparison: `/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/12-codex-openyak-subagents-final-comparison.png`
- Codex conversation reference: `/var/folders/73/g_zg7t154b9_jk2kx3dr9r1h0000gn/T/codex-clipboard-e7ee1951-687c-46e5-a087-3f68f79f6667.png`
- Codex full desktop reference: `/var/folders/73/g_zg7t154b9_jk2kx3dr9r1h0000gn/T/codex-clipboard-6b0e4c19-2056-46ac-93eb-780824f61b03.png`
- OpenYak final conversation capture: `/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/conversation-worklog-alignment/01-openyak-final-1444x1190.png`
- Full-frame conversation comparison: `/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/conversation-worklog-alignment/02-codex-openyak-full-comparison.png`
- Focused conversation comparison: `/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/conversation-worklog-alignment/05-codex-openyak-focus-comparison.png`

The main comparison uses a 1936 × 1192 CSS-pixel frame. The Subagents comparison normalizes the Codex 2× reference to 1099 × 733 and removes OpenYak's 300 px product sidebar, yielding the same 1099 × 733 task-content frame.

The final conversation comparison uses a 1444 × 1190 CSS-pixel frame. The
Codex full-desktop source is 2888 × 2380 at 2× density and was normalized to
1444 × 1190. The focused comparison normalizes the 1622 × 1918 conversation
source to 811 × 959 and compares it with an 811 × 959 crop of the live OpenYak
conversation rail. The content differs because it is live product data; the
comparison contract is typography, density, hierarchy, lifecycle placement,
surface treatment, and Composer stability.

## Matched contract

| Surface | Final OpenYak behavior |
| --- | --- |
| Parent task shell | Stable task title, transcript, Composer, and Summary remain part of one task |
| Wide-screen layout | Summary overlays only when the post-Sidebar task area leaves the 736 px transcript plus the 320 px Summary and a safe gutter; the transcript stays Codex-aligned |
| Compact desktop | Summary remains pinned whenever the real remaining width is below that safe geometry; Composer controls wrap instead of being covered |
| Composer | Two visual layers; Attach, permission mode, workspace, model, Ultra, and Send share one decision row |
| Agent lifecycle | `Working for …`, `Worked for …`, and `You stopped after …`; completed details default collapsed |
| Task Summary | `Progress → Outputs → Subagents → Sources → Inputs → Context`; empty sections hide |
| Outputs | Default expanded, first five visible, `Show N more`, real disclosure semantics, no decorative `+`; parent and descendant origins remain attached after path deduplication |
| Sources / Inputs | Deduplicated task evidence with `View all` / `Show N more`; parent/child, tool, run, and terminal-status provenance remain recoverable |
| Subagents list | Parent-scoped, 48 px tab shell, Active/Done sections, 4/10 initial limits, `Show N more` |
| Subagent detail | `Status → Delegated task → Final response`, including live, loading, unavailable, failed, cancelled, and duration states |
| Needs input | `waiting_input` is visible as `Waiting for input` in the parent Summary and list, including the link's accessible name |
| State continuity | Parent ChatView remains mounted; draft, scroll, Summary, workspace, and focused task state survive list/detail navigation |
| Theme and accessibility | Theme tokens, semantic headings, text status labels, disclosure ARIA, keyboard focus rings, and focus restoration |

## Conversation Work Event Timeline

| Surface | Final OpenYak behavior |
| --- | --- |
| Execution order | Prose, activity, Agent coordination, compaction, and subsequent work render in the original Part order |
| Activity summaries | Only adjacent reasoning/tool events are grouped; step boundaries produce separate Codex-style action rows |
| Agent activity | Swarm and child work use compact, avatar-free pills; lifecycle text stays adjacent as `started working`, `finished`, `waiting`, `failed`, or `cancelled` |
| Progressive disclosure | The pill row remains scannable; the row expands member details and each member still opens the child task |
| Compaction | Context compaction stays at its true point in the transcript as a quiet `Optimizing / Optimized the conversation` row |
| Typography | 736 px reading rail, 15 px / 1.55 prose, 13 px activity and lifecycle labels |
| Message surfaces | User bubbles use restrained fill and border without a shadow; assistant work stays on the page surface |
| Message actions | Low-contrast actions remain discoverable without depending on hover and keep visible keyboard focus |
| Streaming motion | New content uses a 160 ms opacity/3 px append transition with no spring bounce; reduced-motion rules remain respected |
| Streaming boundaries | Progressive text/reasoning buffers flush before a tool begins, so prose → tool order is stable and the previous text cursor disappears immediately |
| Stop terminus | A stopped run preserves partial output and ends with one quiet lifecycle row instead of a prominent alert card |

## Parent Summary evidence lineage

| Contract | Final OpenYak behavior |
| --- | --- |
| Descendant scope | The parent Summary includes valid direct and nested child Sessions while rejecting deleted, cross-parent, and cyclic branches |
| Live state | Active descendants refresh on the live query cadence and settle into Done without requiring a parent-page reload |
| Output deduplication | Identical paths display once while retaining every parent/child producer, Agent run, status, and tool origin |
| Source deduplication | Canonical URLs display once while retaining every origin, including failed and cancelled producers |
| Connector compatibility | Structured source records are extracted from metadata, explicit web/MCP JSON object/list output, MCP `structuredContent`, `ResourceLink`, and embedded resource URIs, covering common `webUrl`, `permalink`, `sourceUrl`, and `canonicalUrl` fields |
| Large-result durability | Source evidence is extracted before output truncation, bounded to a compact versioned envelope, and survives persisted-output compaction |
| Safety | Ordinary text URLs, callback/pagination/decorative URL fields, credential-bearing links, token/signature queries, malformed values, control characters, and non-HTTP(S) URLs are rejected |
| Bounded work | Flat dictionaries, million-item lists, MCP content arrays, JSON strings, evidence items, metadata bytes, and source counts all stop at explicit work budgets without dropping the original tool output or attachments |

### Conversation iteration history

1. Baseline inspection found generic `Done · N tool calls` summaries hoisted
   away from their true transcript position, large Swarm cards, compaction
   rendered after prose, 13 px primary prose, hover-only actions, and spring
   motion.
2. The timeline was rebuilt around ordered Parts and step-bounded activity
   groups. Swarm, Subtask, Compaction, prose, and later tools now keep their
   original order.
3. Swarm and Subtask surfaces were reduced to compact Agent pills with adjacent
   lifecycle text and expandable details. Avatars and decorative identity marks
   were deliberately omitted.
4. The conversation rail, typography, message surfaces, actions, Stop row, and
   append motion were tuned against the supplied Codex screenshots.
5. A clean browser reload at the 1444 × 1190 validation viewport produced no
   new console warnings or errors. Agent-detail expansion/collapse and Activity
   panel opening were exercised in the live product.

### Final conversation findings

- P0: none.
- P1: none.
- P2: none.
- P3: OpenYak retains its own sidebar, project/workspace concepts, model and
  permission visibility, and icon library. These are intentional product
  differences and do not break the Work Mode interaction contract.
- Assets: no new raster assets were required; existing library icons are used.
  Agent avatars, Codex proprietary glyphs, and decorative Mac chrome remain out
  of scope by product decision.

## Deliberate non-matches

- No agent avatars or colored identity marks.
- No Codex-proprietary icon set, native Mac controls, or decorative screenshot features.
- OpenYak's projects, workspace memory, skills, connectors, local providers, and permission visibility remain intact.
- Compact/mobile layouts prioritize non-overlap over a fixed desktop screenshot geometry.

## Dynamic Work Mode regression

The static shell comparison was followed by a live deterministic-stream pass in
the local Codex browser. This pass covered the runtime states that a screenshot
fixture alone cannot validate:

- Incremental text and Markdown render without remount flicker, duplicated
  replay frames, or a duplicate Thinking indicator.
- Stop is immediate, preserves the partial answer, restores the Composer, emits
  one explicit Stopped/Cancelled terminus, and removes the streaming caret and
  trailing Finalizing indicator.
- Event replay is numbered and deduplicated; reconnect, replay gaps, remote
  transport health, and stop-then-resend races no longer create false terminal
  states or cross-contaminate a new stream.
- Agent Swarm state moves live between Active and Done. A selected child opens
  immediately, continues receiving incremental output, and exposes its
  permission, question, plan-review, retry, and reconnect states in the same
  Work view.
- User interaction moves a delegated task through
  `running → waiting_input → running`; stopping the parent immediately cancels
  active ordinary tasks and Swarm members while preserving already-completed
  members.
- Active tasks recovered after a backend restart are reconciled to a real
  terminal state instead of remaining as zombie background work.

Dynamic evidence:

- Streaming in progress: `/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/dynamic-streaming-regression/01-active-stream.png`
- Preserved partial response after Stop: `/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/dynamic-streaming-regression/02-stopped-partial.png`
- Live Subagents list: `/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/dynamic-streaming-regression/04-subagents-active.png`
- Live child-agent response: `/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/dynamic-streaming-regression/05-child-agent-live.png`
- Terminal Subagents list: `/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/dynamic-streaming-regression/06-subagents-done.png`
- Codex/OpenYak Subagents inspection input: `/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/dynamic-streaming-regression/comparison-subagents.png`

## Verification

- Final dynamic Work Mode UI regression: 38 passed.
- Final targeted Work Mode UI suite: 30 passed.
- Final responsive task-shell suite: 3 passed.
- Workspace session-isolation unit suite: 4 passed.
- Focused backend Swarm/Subagents/lifecycle suite: 54 passed.
- TypeScript: passed.
- Full frontend ESLint: passed.
- Production build: passed; all 15 static pages generated.
- Browser capture diagnostics: zero warnings or errors.
- `git diff --check`: passed.
- Combined reference/implementation inspection: no remaining P0, P1, or actionable P2 visual defects.
- Full backend regression after final provenance hardening: 1145 passed, 21 skipped.
- Dynamic Stop regression: 6 passed, including SSE → Swarm → Stop and
  stopped-caret coverage.

Conversation-alignment verification for this final pass:

- Frontend Work Mode, streaming, timeline, and evidence unit suite: 51/51 passed.
- Backend descendant evidence, MCP wrapper, truncation, and bounded source
  provenance suite: 49/49 passed.
- Targeted Chromium conversation, Agent Swarm, Stop, Work Mode shell, and
  Summary/Subagents/child-evidence suite: 41/41 passed.
- TypeScript (`--noEmit --incremental false`): passed.
- Full frontend ESLint: passed.
- Production build: passed; all 15 static pages generated.
- `git diff --check`: passed.
- Clean authenticated browser reload after the final build: no new
  warning/error entries.
- Full-frame and focused combined-image inspection: no remaining P0, P1, or
  actionable P2 conversation defects.
- Independent final visual-contract and provenance/security audits: P0 0,
  P1 0, P2 0.

final result: passed
