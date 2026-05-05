# `backend/app/api/` is a thin `Route` Module; multi-Manager orchestration belongs in the Manager layer

Endpoints in `backend/app/api/` are written with a `Route` decorator family — `route.list / get / create / update / delete` for CRUD, `route.stream / multipart / custom` as in-seam escape hatches. Auth, PermissionRule evaluation, `DomainError → HTTPException` mapping (single global table), and audit are provided by the Module by default; route handlers express only the Manager call. The Manager callable's typed signature is the source of truth for what `Route` injects (via `inspect.signature` at decoration time, fail-fast on mismatch); Managers do not take FastAPI `app.state` or `Request`. Operations that need multiple Manager steps (e.g. `delete_session_cascade`: abort streams + delete uploads + delete row + cleanup index) collapse into a single Manager method — they do **not** orchestrate at the route layer — because that's how the Manager Module earns its Depth and how transactional reasoning stays in one place.

## Considered options

- **Pluggable Concern stack** (per-route `@with_concerns(AuthConcern, PermissionConcern, AuditConcern, ...)`). Rejected: streaming SSE breaks the `before/after` model — Audit fires before stream completion, Idempotency-on-stream is fundamentally broken — and the cognitive cost only pays off above ~5 cross-cutting concerns, while OpenYak has 4 today and no concrete future ones. Future concerns (per-Workspace quota, idempotency) will arrive as named kwargs on the existing decorators (`quota="generation"`, `idempotent=True`), not as a generic plug-in seam — that would be a hypothetical seam (one-adapter rule).
- **Minimalist `route` + `raw` escape hatch** (unusual endpoints drop entirely out of the kernel onto a raw FastAPI router). Rejected: ~15% of routes (multipart uploads, PDF/Markdown exports, native dialogs) are exactly the routes that most need uniform audit and error mapping — letting them escape outside the seam breaks Locality at the wrong 20%.

## Consequences

- Today's `dict`-returning endpoints (`list_session_files`, `list_session_todos`, etc.) need typed Pydantic response schemas. This is API debt the migration surfaces.
- Long-lived services (`stream_manager`, `index_manager`) move from `app.state` to module-level singletons so Managers can call them without FastAPI coupling. See ADR-0008.
- Migration is incremental: `Route` and plain FastAPI `@router.get` coexist during the transition; rewrite proceeds file-by-file, starting with `backend/app/api/sessions.py`.
- A `TestRouteRegistry` adapter lets unit tests dispatch `(verb, path, body, user) → handler return value` without spinning up the FastAPI app or ASGI lifespan.

## Addendum: audit shape (2026-05-04)

The original decision said "audit by default" but did not pin what audit looks like. Pinning it here so every `Route`-decorated endpoint emits a uniform shape and downstream tooling (log search, dashboards) can rely on it.

**Format: `key=value` fields concatenated into the log message string.** Not `extra={...}` — Python's stdlib logger silently drops `extra` keys unless the formatter is explicitly configured to render them, and the project ships with the default formatter by design (no JSON / structlog handler). The `_log_browse_telemetry` helper introduced in #59 is the reference pattern; PR-B adds a parallel `_log_audit` helper. A single `key=value` parser handles both telemetry channels.

**Non-streaming routes — one line per request, emitted on close:**

```
audit user={user} route={route} status_code={status} duration_ms={ms}
```

No new sink, no DB-backed audit table.

**Streaming routes (`route.stream`) — two lines per stream sharing a `stream_id`:**

- **Open** (when the response stream is acquired):
  `audit.stream.open stream_id={id} user={user} route={route} started_at={ts}`
- **Close** (on completion, abort, or error):
  `audit.stream.close stream_id={id} outcome={completed|aborted|error} duration_ms={ms} [error_class={cls}]`

Why two lines instead of one:
- The single before/after model that `Route` uses for non-streaming requests cannot fire "after" — for SSE the response begins immediately and ends an unbounded time later. Logging only on open loses outcome; logging only on close loses the start signal that a stream existed at all (important for orphan detection if the worker dies mid-stream).
- A correlated pair is cheap (the `stream_id` already exists in `GenerationJob`) and makes both queries trivial: "how many streams started today" (count opens) and "what fraction completed cleanly" (join on `stream_id`).

**No per-chunk audit.** Considered and rejected: a 30-second generation with 200 chunks × concurrent streams blows up audit volume by 2-3 orders of magnitude with no analytical payoff — chunk-level data is already in the streaming replay buffer (ADR-0004) when needed. The audit layer's unit of accountability is the request lifecycle, not the wire frame.

The decorator owns log emission; route handlers do not call `logger.info("audit ...")` themselves. If a handler needs richer business-event logging it does so under a different logger name to keep the audit channel clean.

**Logger name: `app.audit`.** All four lines (`audit`, `audit.stream.open`, `audit.stream.close`) are emitted on this logger so consumers can grep / filter / route them as a single channel.
