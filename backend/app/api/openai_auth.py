"""OpenAI OAuth endpoints for ChatGPT subscription access."""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from urllib.parse import urlparse, parse_qs

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from app.api.config import _remove_env_key, _update_env_file
from app.dependencies import ProviderRegistryDep, SettingsDep, get_provider_registry, get_settings
from app.provider.openai_oauth import (
    exchange_code,
    extract_account_id,
    extract_email,
    generate_auth_url,
)
from app.provider.openai_subscription import OpenAISubscriptionProvider, PROVIDER_ID

logger = logging.getLogger(__name__)

router = APIRouter()

# The public OAuth client is registered with this exact redirect URI
OAUTH_CALLBACK_PORT = 1455
OAUTH_REDIRECT_URI = f"http://localhost:{OAUTH_CALLBACK_PORT}/auth/callback"

# In-memory store for pending OAuth flows (state → {code_verifier, redirect_uri})
_pending_flows: dict[str, dict] = {}

# Module-level references for the callback server
_callback_server_task: asyncio.Task | None = None
_app_ref = None  # Reference to FastAPI app, set when login is called


class OpenAISubscriptionStatus(BaseModel):
    is_connected: bool = False
    email: str = ""
    needs_reauth: bool = False


class LoginResponse(BaseModel):
    auth_url: str


# ── Status ──────────────────────────────────────────────────────────────


@router.get("/config/openai-subscription", response_model=OpenAISubscriptionStatus)
async def get_openai_subscription_status(settings: SettingsDep, registry: ProviderRegistryDep) -> OpenAISubscriptionStatus:
    """Check if an OpenAI subscription is connected."""

    provider = registry.get_provider(PROVIDER_ID)
    if provider and settings.openai_oauth_access_token and settings.openai_oauth_account_id:
        return OpenAISubscriptionStatus(
            is_connected=True,
            email=getattr(settings, "openai_oauth_email", ""),
            needs_reauth=getattr(provider, "_needs_reauth", False),
        )
    return OpenAISubscriptionStatus(is_connected=False)


# ── Login (initiate OAuth) ──────────────────────────────────────────────


@router.post("/config/openai-subscription/login", response_model=LoginResponse)
async def login_openai_subscription(request: Request) -> LoginResponse:
    """Start the OpenAI OAuth PKCE flow.

    Returns an auth URL that the frontend should open in a browser tab.
    """
    state = secrets.token_urlsafe(32)
    redirect_uri = OAUTH_REDIRECT_URI

    auth_url, code_verifier = generate_auth_url(redirect_uri, state)

    # Store the pending flow
    _pending_flows[state] = {
        "code_verifier": code_verifier,
        "redirect_uri": redirect_uri,
        "created_at": time.time(),
    }

    # Clean up stale flows (older than 10 minutes)
    cutoff = time.time() - 600
    stale = [k for k, v in _pending_flows.items() if v["created_at"] < cutoff]
    for k in stale:
        del _pending_flows[k]

    # Start a temporary callback server on the registered redirect port
    asyncio.create_task(_start_callback_listener(request.app))

    return LoginResponse(auth_url=auth_url)


# ── OAuth Callback ──────────────────────────────────────────────────────


@router.get("/config/openai-subscription/callback", response_class=HTMLResponse)
async def openai_subscription_callback(request: Request) -> HTMLResponse:
    """Handle the OAuth callback from OpenAI (fallback on main backend port).

    Exchanges the authorization code for tokens, extracts the account ID,
    registers the subscription provider, and returns a success HTML page.
    """
    global _app_ref
    _app_ref = request.app

    code = request.query_params.get("code", "")
    state = request.query_params.get("state", "")
    error = request.query_params.get("error", "")

    if error:
        return HTMLResponse(
            _error_html(f"Authentication error: {error} — {request.query_params.get('error_description', '')}"),
            status_code=400,
        )

    if not code or not state:
        return HTMLResponse(_error_html("Missing code or state parameter"), status_code=400)

    try:
        email = await _complete_oauth_flow_internal(code, state)
    except HTTPException as exc:
        return HTMLResponse(_error_html(exc.detail), status_code=exc.status_code)
    except Exception as e:
        logger.error("OAuth flow failed: %s", e)
        return HTMLResponse(_error_html(str(e)), status_code=500)

    return HTMLResponse(_success_html(email))


# ── Shared OAuth completion ────────────────────────────────────────────


async def _complete_oauth_flow_internal(code: str, state: str) -> str:
    """Core OAuth completion. Uses module-level _app_ref. Returns email on success."""
    flow = _pending_flows.pop(state, None)
    if not flow:
        raise HTTPException(status_code=400, detail="Invalid or expired state. Please try again.")

    try:
        tokens = await exchange_code(
            code=code,
            redirect_uri=flow["redirect_uri"],
            code_verifier=flow["code_verifier"],
        )
    except Exception as e:
        logger.error("OAuth code exchange failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Token exchange failed: {e}")

    access_token = tokens.get("access_token", "")
    refresh_token = tokens.get("refresh_token", "")
    id_token = tokens.get("id_token", "")
    expires_in = tokens.get("expires_in", 3600)
    expires_at_ms = int(time.time() * 1000) + expires_in * 1000

    if not access_token:
        raise HTTPException(status_code=500, detail="No access token received")

    try:
        account_id = extract_account_id(id_token)
    except Exception as e:
        logger.error("Failed to extract account ID: %s", e)
        raise HTTPException(status_code=500, detail=f"Failed to extract account ID: {e}")

    email = extract_email(id_token) if id_token else ""

    # Persist tokens to .env
    _update_env_file("OPENYAK_OPENAI_OAUTH_ACCESS_TOKEN", access_token)
    _update_env_file("OPENYAK_OPENAI_OAUTH_REFRESH_TOKEN", refresh_token)
    _update_env_file("OPENYAK_OPENAI_OAUTH_ACCOUNT_ID", account_id)
    _update_env_file("OPENYAK_OPENAI_OAUTH_EXPIRES_AT", str(expires_at_ms))
    _update_env_file("OPENYAK_OPENAI_OAUTH_EMAIL", email)

    # Update runtime settings
    settings = get_settings()
    settings.openai_oauth_access_token = access_token
    settings.openai_oauth_refresh_token = refresh_token
    settings.openai_oauth_account_id = account_id
    settings.openai_oauth_expires_at = expires_at_ms
    settings.openai_oauth_email = email

    # Register provider
    registry = get_provider_registry()
    provider = OpenAISubscriptionProvider(
        access_token=access_token,
        account_id=account_id,
        refresh_token=refresh_token,
        expires_at_ms=expires_at_ms,
        settings=settings,
    )
    registry.register(provider)

    # Refresh model index
    try:
        await registry.refresh_models()
    except Exception as e:
        logger.warning("Model refresh failed after OpenAI subscription connect: %s", e)

    return email


# ── Temporary callback server on port 1455 ─────────────────────────────


async def _start_callback_listener(app):
    """Start a one-shot HTTP server on port 1455 for the OAuth callback."""
    global _callback_server_task, _app_ref
    _app_ref = app

    # Cancel any existing listener
    if _callback_server_task and not _callback_server_task.done():
        _callback_server_task.cancel()

    async def _run_server():
        server_ref = [None]

        async def handle_connection(reader, writer):
            try:
                request_line = await asyncio.wait_for(reader.readline(), timeout=5)
                _, path, _ = request_line.decode().split(" ", 2)

                # Read and discard headers
                while True:
                    line = await reader.readline()
                    if line == b"\r\n" or line == b"\n" or not line:
                        break

                parsed = urlparse(path)
                params = parse_qs(parsed.query)

                code = params.get("code", [None])[0]
                state = params.get("state", [None])[0]
                error = params.get("error", [None])[0]

                if error:
                    error_desc = params.get("error_description", [""])[0]
                    html = _error_html(f"Authentication error: {error} — {error_desc}")
                    status = 400
                elif not code or not state:
                    html = _error_html("Missing code or state parameter")
                    status = 400
                else:
                    try:
                        email = await _complete_oauth_flow_internal(code, state)
                        html = _success_html(email)
                        status = 200
                    except HTTPException as exc:
                        html = _error_html(exc.detail)
                        status = exc.status_code
                    except Exception as e:
                        logger.error("OAuth callback failed: %s", e)
                        html = _error_html(str(e))
                        status = 500

                status_text = {200: "OK", 400: "Bad Request", 500: "Internal Server Error"}.get(status, "Error")
                body = html.encode()
                response = (
                    f"HTTP/1.1 {status} {status_text}\r\n"
                    f"Content-Type: text/html; charset=utf-8\r\n"
                    f"Content-Length: {len(body)}\r\n"
                    f"Connection: close\r\n"
                    f"\r\n"
                ).encode() + body
                writer.write(response)
                await writer.drain()
            except Exception as e:
                logger.error("Callback listener error: %s", e)
            finally:
                writer.close()
                # One-shot: stop after handling a single request
                if server_ref[0]:
                    server_ref[0].close()

        try:
            server = await asyncio.start_server(handle_connection, "127.0.0.1", OAUTH_CALLBACK_PORT)
            server_ref[0] = server
            logger.info("OAuth callback listener started on port %d", OAUTH_CALLBACK_PORT)
            async with server:
                await asyncio.wait_for(server.serve_forever(), timeout=600)
        except asyncio.TimeoutError:
            logger.info("OAuth callback listener timed out after 10 minutes")
        except asyncio.CancelledError:
            logger.info("OAuth callback listener cancelled")
        except OSError as e:
            logger.warning("Could not start OAuth callback listener on port %d: %s (use manual paste fallback)", OAUTH_CALLBACK_PORT, e)

    _callback_server_task = asyncio.create_task(_run_server())


# ── Manual paste-based callback ────────────────────────────────────────


class ManualCallbackRequest(BaseModel):
    callback_url: str


@router.post("/config/openai-subscription/manual-callback")
async def manual_openai_callback(request: Request, body: ManualCallbackRequest):
    """Handle a manually pasted OAuth callback URL.

    The user copies the full redirect URL from their browser after logging in
    on OpenAI and pastes it here. We extract code + state and complete the flow.
    """
    global _app_ref
    _app_ref = request.app

    parsed = urlparse(body.callback_url)
    params = parse_qs(parsed.query)

    code = params.get("code", [None])[0]
    state = params.get("state", [None])[0]

    if not code or not state:
        raise HTTPException(status_code=400, detail="URL is missing code or state parameters")

    email = await _complete_oauth_flow_internal(code, state)
    return {"success": True, "email": email}


# ── Disconnect ──────────────────────────────────────────────────────────


@router.delete("/config/openai-subscription", response_model=OpenAISubscriptionStatus)
async def disconnect_openai_subscription(settings: SettingsDep, registry: ProviderRegistryDep) -> OpenAISubscriptionStatus:
    """Disconnect the OpenAI subscription and remove tokens."""
    # Clear runtime settings
    settings.openai_oauth_access_token = ""
    settings.openai_oauth_refresh_token = ""
    settings.openai_oauth_account_id = ""
    settings.openai_oauth_expires_at = 0
    settings.openai_oauth_email = ""

    # Remove from .env
    _remove_env_key("OPENYAK_OPENAI_OAUTH_ACCESS_TOKEN")
    _remove_env_key("OPENYAK_OPENAI_OAUTH_REFRESH_TOKEN")
    _remove_env_key("OPENYAK_OPENAI_OAUTH_ACCOUNT_ID")
    _remove_env_key("OPENYAK_OPENAI_OAUTH_EXPIRES_AT")
    _remove_env_key("OPENYAK_OPENAI_OAUTH_EMAIL")

    # Unregister provider
    registry.unregister(PROVIDER_ID)

    return OpenAISubscriptionStatus(is_connected=False)


# ── HTML responses ──────────────────────────────────────────────────────


def _success_html(email: str) -> str:
    display = f" as <strong>{email}</strong>" if email else ""
    return f"""<!DOCTYPE html>
<html>
<head><title>OpenYak — Authentication Successful</title></head>
<body style="font-family: -apple-system, system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #e0e0e0;">
  <div style="text-align: center; max-width: 400px; padding: 2rem;">
    <div style="font-size: 3rem; margin-bottom: 1rem;">&#10003;</div>
    <h1 style="font-size: 1.25rem; margin-bottom: 0.5rem;">Authentication Successful</h1>
    <p style="color: #888; font-size: 0.875rem;">Signed in{display}. ChatGPT subscription models are now available in OpenYak.</p>
    <p style="color: #666; font-size: 0.75rem; margin-top: 1.5rem;">You can close this tab.</p>
  </div>
</body>
</html>"""


def _error_html(message: str) -> str:
    return f"""<!DOCTYPE html>
<html>
<head><title>OpenYak — Authentication Failed</title></head>
<body style="font-family: -apple-system, system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #e0e0e0;">
  <div style="text-align: center; max-width: 400px; padding: 2rem;">
    <div style="font-size: 3rem; margin-bottom: 1rem;">&#10007;</div>
    <h1 style="font-size: 1.25rem; margin-bottom: 0.5rem;">Authentication Failed</h1>
    <p style="color: #f87171; font-size: 0.875rem;">{message}</p>
    <p style="color: #666; font-size: 0.75rem; margin-top: 1.5rem;">Please close this tab and try again.</p>
  </div>
</body>
</html>"""
