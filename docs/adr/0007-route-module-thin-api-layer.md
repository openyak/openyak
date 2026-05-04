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
