# Long-lived services are module-level singletons, not on `app.state`

Long-lived services — `stream_manager`, `index_manager`, `provider_registry`, `tool_registry`, and similar — live as module-level singletons accessed by import (`from app.streaming import get_stream_manager`), not as attributes on FastAPI's `app.state`. The lifespan handler still constructs and shuts them down, but it registers them into the owning module rather than holding them.

This is required by ADR-0007: route handlers under the `Route` Module call into Managers, and Managers do not take FastAPI's `Request` or `app.state`. For multi-step operations like `delete_session_cascade(db, session_id)` to live in the Manager layer (where transactional reasoning belongs), the Manager must be able to reach `stream_manager.abort_session()` and `index_manager.cleanup_session()` without an HTTP-layer dependency. Module-level singletons let the Manager layer collapse multi-step operations cleanly while keeping FastAPI consumption contained to the Route Module and the lifespan.

## Consequences

- Tests replace a singleton via the module's setter (`set_stream_manager_for_tests(...)`) or via dependency injection at the Manager call site for the rare unit test that needs it; not via `app.state` overrides.
- Background workers and CLI entry points (no FastAPI app) construct and register the same singletons in their own bootstrap, mirroring the lifespan path.
