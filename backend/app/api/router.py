"""Aggregate all API routers."""

from __future__ import annotations

from fastapi import APIRouter

from app.api import agents as agents_api
from app.api import artifacts as artifacts_api
from app.api import automations as automations_api
from app.api import workspace_memory as workspace_memory_api
from app.api import channels as channels_api
from app.api import ollama as ollama_api
from app.api import chat as chat_api
from app.api import config as config_api
from app.api import connectors as connectors_api
from app.api import files as files_api
from app.api import google_auth as google_auth_api
from app.api import mcp as mcp_api
from app.api import messages as messages_api
from app.api import models as models_api
from app.api import fts as fts_api
from app.api import openai_auth as openai_auth_api
from app.api import plugins as plugins_api
from app.api import remote as remote_api
from app.api import rapid_mlx as rapid_mlx_api
from app.api import sessions as sessions_api
from app.api import skills as skills_api
from app.api import tools as tools_api
from app.api import usage as usage_api

api_router = APIRouter()

api_router.include_router(models_api.router, tags=["models"])
api_router.include_router(chat_api.router, tags=["chat"])
api_router.include_router(agents_api.router, tags=["agents"])
api_router.include_router(tools_api.router, tags=["tools"])
api_router.include_router(skills_api.router, tags=["skills"])
api_router.include_router(sessions_api.router, tags=["sessions"])
api_router.include_router(messages_api.router, tags=["messages"])
api_router.include_router(files_api.router, tags=["files"])
api_router.include_router(artifacts_api.router, tags=["artifacts"])
api_router.include_router(usage_api.router, tags=["usage"])
api_router.include_router(config_api.router, tags=["config"])
api_router.include_router(openai_auth_api.router, tags=["openai-auth"])
api_router.include_router(fts_api.router, tags=["fts"])
api_router.include_router(mcp_api.router, tags=["mcp"])
api_router.include_router(connectors_api.router, tags=["connectors"])
api_router.include_router(google_auth_api.router, tags=["google"])
api_router.include_router(plugins_api.router, tags=["plugins"])
api_router.include_router(remote_api.router, tags=["remote"])
api_router.include_router(automations_api.router, tags=["automations"])
api_router.include_router(ollama_api.router, tags=["ollama"])
api_router.include_router(rapid_mlx_api.router, tags=["rapid-mlx"])
api_router.include_router(channels_api.router, tags=["channels"])
api_router.include_router(workspace_memory_api.router, tags=["workspace-memory"])
