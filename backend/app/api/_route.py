"""Typed Route decorators for thin API handlers per ADR-0007.

`Route` wraps a FastAPI ``APIRouter`` and turns a Manager callable plus an
HTTP verb into a registered endpoint. The Manager signature is the source of
truth for what the route binds: path params come from the URL pattern, body
fields are unpacked (or the whole body model passed through) when a body is
declared, ``AsyncSession`` is wired to ``get_db``, and any remaining typed
param becomes a query.

Decoration-time validation (``inspect.signature``) fails fast on:

- non-async Managers,
- untyped params,
- ``Request`` / ``Response`` / ``app`` params (Managers do not see FastAPI
  primitives — that lives at the Route layer per ADR-0007),
- path placeholders that have no matching Manager param.

The decorator family also owns audit logging — one ``key=value`` line on
close for non-streaming routes, an open/close pair sharing a ``stream_id``
for ``route.stream`` (per the audit-shape addendum to ADR-0007).
``DomainError`` raised inside a Manager propagates to the global handler
registered by :mod:`app.errors`; routes do not catch.

This module is the foundation only — it is not used by any production
router yet. ``backend/app/api/sessions.py`` migrates onto it in #24 PR-C
and proves the contract; sub-issues #31-#53 each migrate one file.
"""

from __future__ import annotations

import inspect
import logging
import re
import time
import typing
import uuid
from typing import Any, Awaitable, Callable, Type, get_type_hints

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.agent import AgentRegistry
from app.dependencies import (
    get_agent_registry,
    get_db,
    get_provider_registry,
    get_session_factory,
    get_stream_manager,
)
from app.errors import NotFound
from app.provider.registry import ProviderRegistry
from app.streaming.manager import StreamManager

audit_log = logging.getLogger("app.audit")


class RouteSignatureError(TypeError):
    """Raised at decoration time when a Manager signature is invalid for Route."""


# Plain type → dependency injector for known long-lived services. Generic
# aliases (e.g. ``async_sessionmaker[AsyncSession]``) are matched via
# ``typing.get_origin`` so callers can keep their natural type annotations.
# Each entry is added when a sub-issue's Manager calls for it; do not add
# entries speculatively (one-adapter rule).
_TYPE_TO_INJECTOR: dict[type, Callable[..., Any]] = {
    AsyncSession: get_db,
    StreamManager: get_stream_manager,
    ProviderRegistry: get_provider_registry,
    AgentRegistry: get_agent_registry,
    async_sessionmaker: get_session_factory,
}


def _resolve_injector(ann: Any) -> Callable[..., Any] | None:
    """Map a type annotation to its dependency injector, if any.

    Handles plain classes (``AsyncSession``) and generic aliases
    (``async_sessionmaker[AsyncSession]``) — both resolve to the same
    injector since the request-time value is identical.
    """
    if isinstance(ann, type) and ann in _TYPE_TO_INJECTOR:
        return _TYPE_TO_INJECTOR[ann]
    origin = typing.get_origin(ann)
    if origin is not None and origin in _TYPE_TO_INJECTOR:
        return _TYPE_TO_INJECTOR[origin]
    return None


# ---------------------------------------------------------------------------
# Audit logging — see ADR-0007 audit-shape addendum
# ---------------------------------------------------------------------------


def _log_audit(*, user: str, route: str, status_code: int, duration_ms: int) -> None:
    fields = [
        f"user={user}",
        f"route={route}",
        f"status_code={status_code}",
        f"duration_ms={duration_ms}",
    ]
    audit_log.info("audit %s", " ".join(fields))


def _log_stream_open(*, stream_id: str, user: str, route: str, started_at: float) -> None:
    fields = [
        f"stream_id={stream_id}",
        f"user={user}",
        f"route={route}",
        f"started_at={started_at:.3f}",
    ]
    audit_log.info("audit.stream.open %s", " ".join(fields))


def _log_stream_close(
    *,
    stream_id: str,
    outcome: str,
    duration_ms: int,
    error_class: str | None = None,
) -> None:
    fields = [
        f"stream_id={stream_id}",
        f"outcome={outcome}",
        f"duration_ms={duration_ms}",
    ]
    if error_class:
        fields.append(f"error_class={error_class}")
    audit_log.info("audit.stream.close %s", " ".join(fields))


def _resolve_user(request: Request) -> str:
    """Best-effort caller identity for audit.

    Contract: ``AuthMiddleware`` sets ``request.state.user`` to a ``str | None``
    user-id (or leaves it unset for unauthenticated requests). The ``str()``
    coercion defends against future drift — if the value ever becomes a
    ``User`` object or dict, an unconverted value would render as
    ``user={'id': ...}`` and silently break the ``key=value`` audit parser.
    """
    raw = getattr(request.state, "user", None)
    return str(raw) if raw else "anonymous"


# ---------------------------------------------------------------------------
# Signature validation
# ---------------------------------------------------------------------------


_PATH_PLACEHOLDER = re.compile(r"\{([^}:]+)(?::[^}]*)?\}")
_FORBIDDEN_PARAM_NAMES = {"request", "response", "app", "_body"}
_FORBIDDEN_PARAM_TYPES: tuple[type, ...] = (Request, Response)


def _path_param_names(path: str) -> list[str]:
    return _PATH_PLACEHOLDER.findall(path)


class _Bindings:
    """Resolved param-by-param plan for a Manager + (verb, path, body)."""

    def __init__(self) -> None:
        self.path: list[str] = []
        self.deps: dict[str, type] = {}
        self.body_fields: list[str] = []
        self.body_param: str | None = None
        self.queries: dict[str, inspect.Parameter] = {}


def _validate_and_bind(
    manager: Callable[..., Awaitable[Any]],
    *,
    path: str,
    body: Type[BaseModel] | None,
) -> _Bindings:
    if not inspect.iscoroutinefunction(manager):
        raise RouteSignatureError(
            f"Manager `{manager.__qualname__}` must be `async def`."
        )

    try:
        hints = get_type_hints(manager)
    except Exception as exc:
        raise RouteSignatureError(
            f"Could not resolve type hints for `{manager.__qualname__}`: {exc}"
        ) from exc

    declared_path = _path_param_names(path)
    body_field_set = set(body.model_fields.keys()) if body is not None else set()

    plan = _Bindings()
    sig = inspect.signature(manager)

    for name, param in sig.parameters.items():
        if name in _FORBIDDEN_PARAM_NAMES:
            raise RouteSignatureError(
                f"Manager `{manager.__qualname__}` has forbidden param `{name}` — "
                "Route does not pass FastAPI primitives to Managers."
            )
        if name not in hints:
            raise RouteSignatureError(
                f"Manager `{manager.__qualname__}` param `{name}` is untyped."
            )
        ann = hints[name]
        if isinstance(ann, type) and issubclass(ann, _FORBIDDEN_PARAM_TYPES):
            raise RouteSignatureError(
                f"Manager `{manager.__qualname__}` param `{name}: {ann.__name__}` — "
                "Route does not pass FastAPI primitives to Managers."
            )

        # Body-as-whole-model: typed as a BaseModel subclass. Must match the
        # declared body, otherwise FastAPI would later try to resolve the
        # mismatched model from query params and surface a confusing error
        # far from the cause — fail fast at decoration time instead.
        if isinstance(ann, type) and issubclass(ann, BaseModel):
            if body is None:
                raise RouteSignatureError(
                    f"Manager `{manager.__qualname__}` param "
                    f"`{name}: {ann.__name__}` is a BaseModel but the route "
                    "declares no `body=...`."
                )
            if ann is not body:
                raise RouteSignatureError(
                    f"Manager `{manager.__qualname__}` param "
                    f"`{name}: {ann.__name__}` does not match the declared "
                    f"body `{body.__name__}`."
                )
            if plan.body_param is not None:
                raise RouteSignatureError(
                    f"Manager `{manager.__qualname__}` declares two body-typed params."
                )
            plan.body_param = name
            continue

        if name in declared_path:
            plan.path.append(name)
            continue

        if name in body_field_set:
            plan.body_fields.append(name)
            continue

        if _resolve_injector(ann) is not None:
            plan.deps[name] = ann
            continue

        plan.queries[name] = param

    missing_path = set(declared_path) - set(plan.path)
    if missing_path:
        raise RouteSignatureError(
            f"Path `{path}` declares placeholder(s) {sorted(missing_path)} but "
            f"Manager `{manager.__qualname__}` has no matching param."
        )

    return plan


# ---------------------------------------------------------------------------
# Endpoint generation
# ---------------------------------------------------------------------------


def _build_endpoint(
    manager: Callable[..., Awaitable[Any]],
    plan: _Bindings,
    body: Type[BaseModel] | None,
    *,
    success_status: int,
    not_found_on_none: bool,
    not_found_message: str,
) -> Callable[..., Awaitable[Any]]:
    """Synthesize the FastAPI endpoint that wires request → Manager call."""

    sig = inspect.signature(manager)
    hints = get_type_hints(manager)

    async def endpoint(request: Request, **kwargs: Any) -> Any:
        started = time.perf_counter()
        status_code = success_status
        try:
            mgr_kwargs: dict[str, Any] = {}
            for name in plan.path:
                mgr_kwargs[name] = kwargs[name]
            for name, _ in plan.deps.items():
                mgr_kwargs[name] = kwargs[name]
            for name, _ in plan.queries.items():
                if name in kwargs:
                    mgr_kwargs[name] = kwargs[name]
            if plan.body_param is not None:
                mgr_kwargs[plan.body_param] = kwargs["_body"]
            elif plan.body_fields:
                body_obj: BaseModel = kwargs["_body"]
                for name in plan.body_fields:
                    mgr_kwargs[name] = getattr(body_obj, name)

            result = await manager(**mgr_kwargs)
            if result is None and not_found_on_none:
                raise NotFound(not_found_message)
            return result
        except Exception as exc:
            status_code = getattr(exc, "status_code", 500)
            raise
        finally:
            # Audit reflects the Manager's outcome. If response_model
            # serialization fails downstream of this `finally` (e.g. the
            # Manager returned a value the schema can't validate), the
            # audit line records status=success while the client receives
            # 500. That matches the "Manager succeeded; failure was at the
            # boundary" reading; dashboards consuming audit should treat
            # 500s in error-handler logs as the authoritative count.
            duration_ms = int((time.perf_counter() - started) * 1000)
            _log_audit(
                user=_resolve_user(request),
                route=f"{request.method} {request.url.path}",
                status_code=status_code,
                duration_ms=duration_ms,
            )

    parameters: list[inspect.Parameter] = [
        inspect.Parameter(
            "request",
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            annotation=Request,
        )
    ]
    for name in plan.path:
        parameters.append(
            inspect.Parameter(
                name,
                inspect.Parameter.KEYWORD_ONLY,
                annotation=hints[name],
            )
        )
    for name, ann in plan.deps.items():
        injector = _resolve_injector(ann)
        parameters.append(
            inspect.Parameter(
                name,
                inspect.Parameter.KEYWORD_ONLY,
                annotation=ann,
                default=Depends(injector),
            )
        )
    for name, original in plan.queries.items():
        default = original.default
        parameters.append(
            inspect.Parameter(
                name,
                inspect.Parameter.KEYWORD_ONLY,
                annotation=hints[name],
                default=default,
            )
        )
    if body is not None:
        parameters.append(
            inspect.Parameter(
                "_body",
                inspect.Parameter.KEYWORD_ONLY,
                annotation=body,
            )
        )

    endpoint.__signature__ = inspect.Signature(  # type: ignore[attr-defined]
        parameters=parameters,
        return_annotation=sig.return_annotation,
    )
    endpoint.__name__ = f"{manager.__name__}_endpoint"
    endpoint.__qualname__ = endpoint.__name__
    return endpoint


# ---------------------------------------------------------------------------
# Route class
# ---------------------------------------------------------------------------


class Route:
    """Typed Route decorators for thin API handlers (ADR-0007).

    Wrap any number of Manager callables into a FastAPI ``APIRouter`` exposed
    via ``Route.api_router``. Use the verb-named methods for CRUD,
    :meth:`custom` for hand-written handlers that still get audit + global
    error mapping, and :meth:`stream` for SSE-style endpoints.
    """

    def __init__(self, prefix: str = "", tags: list[str] | None = None) -> None:
        self.api_router = APIRouter(prefix=prefix, tags=tags or [])

    # CRUD ------------------------------------------------------------------

    def list(
        self,
        path: str,
        *,
        manager: Callable[..., Awaitable[Any]],
        response_model: Any = None,
    ) -> None:
        self._register("GET", path, manager, response_model=response_model)

    def get(
        self,
        path: str,
        *,
        manager: Callable[..., Awaitable[Any]],
        response_model: Any = None,
        not_found_on_none: bool = False,
        not_found_message: str = "Not found",
    ) -> None:
        self._register(
            "GET",
            path,
            manager,
            response_model=response_model,
            not_found_on_none=not_found_on_none,
            not_found_message=not_found_message,
        )

    def create(
        self,
        path: str,
        *,
        manager: Callable[..., Awaitable[Any]],
        body: Type[BaseModel] | None = None,
        response_model: Any = None,
        status_code: int = 201,
    ) -> None:
        self._register(
            "POST",
            path,
            manager,
            body=body,
            response_model=response_model,
            status_code=status_code,
        )

    def update(
        self,
        path: str,
        *,
        manager: Callable[..., Awaitable[Any]],
        body: Type[BaseModel] | None = None,
        response_model: Any = None,
        not_found_on_none: bool = False,
        not_found_message: str = "Not found",
    ) -> None:
        self._register(
            "PATCH",
            path,
            manager,
            body=body,
            response_model=response_model,
            not_found_on_none=not_found_on_none,
            not_found_message=not_found_message,
        )

    def delete(
        self,
        path: str,
        *,
        manager: Callable[..., Awaitable[Any]],
        response_model: Any = None,
    ) -> None:
        self._register("DELETE", path, manager, response_model=response_model)

    # Escape hatches --------------------------------------------------------

    def custom(
        self,
        method: str,
        path: str,
        *,
        handler: Callable[..., Awaitable[Any]],
        response_model: Any = None,
        status_code: int = 200,
    ) -> None:
        """Register a hand-written async handler. Audit logged like CRUD;
        signature validation is skipped (the handler may legitimately accept
        Request, Response, etc.)."""
        if not inspect.iscoroutinefunction(handler):
            raise RouteSignatureError(
                f"Custom handler `{handler.__qualname__}` must be `async def`."
            )

        wrapped = _wrap_with_audit(handler)
        self.api_router.add_api_route(
            path,
            wrapped,
            methods=[method.upper()],
            response_model=response_model,
            status_code=status_code,
        )

    def stream(
        self,
        path: str,
        *,
        handler: Callable[..., Awaitable[Any]],
        method: str = "POST",
        status_code: int = 200,
    ) -> None:
        """Register a streaming handler. Emits open + close audit lines
        sharing a ``stream_id`` (passed to the handler as a kwarg)."""
        if not inspect.iscoroutinefunction(handler):
            raise RouteSignatureError(
                f"Stream handler `{handler.__qualname__}` must be `async def`."
            )

        wrapped = _wrap_with_stream_audit(handler)
        self.api_router.add_api_route(
            path,
            wrapped,
            methods=[method.upper()],
            status_code=status_code,
        )

    # Internal --------------------------------------------------------------

    def _register(
        self,
        method: str,
        path: str,
        manager: Callable[..., Awaitable[Any]],
        *,
        body: Type[BaseModel] | None = None,
        response_model: Any = None,
        status_code: int = 200,
        not_found_on_none: bool = False,
        not_found_message: str = "Not found",
    ) -> None:
        plan = _validate_and_bind(manager, path=path, body=body)
        endpoint = _build_endpoint(
            manager,
            plan,
            body,
            success_status=status_code,
            not_found_on_none=not_found_on_none,
            not_found_message=not_found_message,
        )
        self.api_router.add_api_route(
            path,
            endpoint,
            methods=[method.upper()],
            response_model=response_model,
            status_code=status_code,
        )


# ---------------------------------------------------------------------------
# Custom / stream wrappers
# ---------------------------------------------------------------------------


def _wrap_with_audit(handler: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
    """Wrap a hand-written async handler with one audit line on close."""

    sig = inspect.signature(handler)
    has_request = any(
        p.annotation is Request or n == "request" for n, p in sig.parameters.items()
    )

    async def wrapped(*args: Any, **kwargs: Any) -> Any:
        request: Request | None = kwargs.get("request") if has_request else None
        if request is None:
            for arg in list(args) + list(kwargs.values()):
                if isinstance(arg, Request):
                    request = arg
                    break

        started = time.perf_counter()
        status_code = 200
        try:
            return await handler(*args, **kwargs)
        except Exception as exc:
            status_code = getattr(exc, "status_code", 500)
            raise
        finally:
            duration_ms = int((time.perf_counter() - started) * 1000)
            _log_audit(
                user=_resolve_user(request) if request is not None else "anonymous",
                route=(
                    f"{request.method} {request.url.path}"
                    if request is not None
                    else "custom"
                ),
                status_code=status_code,
                duration_ms=duration_ms,
            )

    wrapped.__signature__ = sig  # type: ignore[attr-defined]
    wrapped.__name__ = f"{handler.__name__}_audited"
    wrapped.__qualname__ = wrapped.__name__
    return wrapped


def _wrap_with_stream_audit(
    handler: Callable[..., Awaitable[Any]],
) -> Callable[..., Awaitable[Any]]:
    """Wrap a streaming handler with open + close audit lines.

    The handler must take a keyword argument ``stream_id: str`` — Route
    generates a fresh id per request and propagates it so the close line
    can be correlated to the open line. The handler's job is to return the
    streaming response; lifecycle bookkeeping lives here.
    """

    original_sig = inspect.signature(handler)
    if "stream_id" not in original_sig.parameters:
        raise RouteSignatureError(
            f"Stream handler `{handler.__qualname__}` must accept a "
            "`stream_id: str` keyword argument."
        )

    # Strip stream_id from FastAPI's view of the handler signature — it is
    # synthesised by Route, not extracted from the request.
    public_params = [p for n, p in original_sig.parameters.items() if n != "stream_id"]
    public_sig = original_sig.replace(parameters=public_params)

    async def wrapped(*args: Any, **kwargs: Any) -> Any:
        request: Request | None = kwargs.get("request")
        if request is None:
            for arg in list(args) + list(kwargs.values()):
                if isinstance(arg, Request):
                    request = arg
                    break

        stream_id = uuid.uuid4().hex
        started_at = time.time()
        started_perf = time.perf_counter()

        _log_stream_open(
            stream_id=stream_id,
            user=_resolve_user(request) if request is not None else "anonymous",
            route=(
                f"{request.method} {request.url.path}"
                if request is not None
                else "stream"
            ),
            started_at=started_at,
        )

        outcome = "completed"
        error_class: str | None = None
        try:
            return await handler(*args, stream_id=stream_id, **kwargs)
        except Exception as exc:
            outcome = "error"
            error_class = type(exc).__name__
            raise
        finally:
            duration_ms = int((time.perf_counter() - started_perf) * 1000)
            _log_stream_close(
                stream_id=stream_id,
                outcome=outcome,
                duration_ms=duration_ms,
                error_class=error_class,
            )

    wrapped.__signature__ = public_sig  # type: ignore[attr-defined]
    wrapped.__name__ = f"{handler.__name__}_streamed"
    wrapped.__qualname__ = wrapped.__name__
    return wrapped
