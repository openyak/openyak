"""Automation (scheduled task) CRUD and execution endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select, delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db
from app.models.scheduled_task import ScheduledTask
from app.models.task_run import TaskRun
from app.schemas.automation import (
    AutomationCreate,
    AutomationResponse,
    AutomationUpdate,
    TaskRunResponse,
    TemplateResponse,
)
from app.scheduler.templates import get_template_by_id, get_templates
from app.utils.id import generate_ulid

logger = logging.getLogger(__name__)

router = APIRouter()


def _get_scheduler(request: Request):
    scheduler = getattr(request.app.state, "task_scheduler", None)
    if scheduler is None:
        raise HTTPException(503, "Task scheduler not available")
    return scheduler


# ------------------------------------------------------------------
# Templates
# ------------------------------------------------------------------


def _parse_lang(request: Request) -> str:
    """Extract language preference from Accept-Language header."""
    accept = request.headers.get("accept-language", "")
    if accept.startswith("en"):
        return "en"
    return "zh"


@router.get("/automations/loop-presets")
async def list_loop_presets() -> list[dict]:
    """List built-in loop presets."""
    from app.scheduler.executor import LOOP_PRESETS
    return [
        {"id": k, "name": k.replace("-", " ").title(), "prompt": v}
        for k, v in LOOP_PRESETS.items()
    ]


@router.get("/automations/templates", response_model=list[TemplateResponse])
async def list_templates(request: Request) -> list[TemplateResponse]:
    """List built-in automation templates."""
    lang = _parse_lang(request)
    return [TemplateResponse(**t) for t in get_templates(lang)]


@router.post("/automations/from-template", response_model=AutomationResponse)
async def create_from_template(
    request: Request,
    template_id: str,
    db: AsyncSession = Depends(get_db),
) -> AutomationResponse:
    """Create a new automation from a built-in template."""
    lang = _parse_lang(request)
    template = get_template_by_id(template_id, lang)
    if template is None:
        raise HTTPException(404, f"Template '{template_id}' not found")

    task = ScheduledTask(
        id=generate_ulid(),
        name=template["name"],
        description=template["description"],
        prompt=template["prompt"],
        schedule_config=template["schedule_config"] or {},
        template_id=template_id,
        loop_max_iterations=template.get("loop_max_iterations"),
        loop_preset=template.get("loop_preset"),
    )
    db.add(task)
    await db.flush()

    scheduler = _get_scheduler(request)
    await scheduler.sync_task(task.id)

    # Re-read to get computed next_run_at
    await db.refresh(task)
    return AutomationResponse.model_validate(task)


# ------------------------------------------------------------------
# CRUD
# ------------------------------------------------------------------


@router.get("/automations", response_model=list[AutomationResponse])
async def list_automations(
    db: AsyncSession = Depends(get_db),
) -> list[AutomationResponse]:
    """List all scheduled tasks."""
    result = await db.execute(
        select(ScheduledTask).order_by(ScheduledTask.time_created.desc())
    )
    tasks = result.scalars().all()
    return [AutomationResponse.model_validate(t) for t in tasks]


@router.post("/automations", response_model=AutomationResponse)
async def create_automation(
    request: Request,
    body: AutomationCreate,
    db: AsyncSession = Depends(get_db),
) -> AutomationResponse:
    """Create a new scheduled task."""
    schedule_data = body.schedule_config.model_dump(exclude_none=True) if body.schedule_config else {}
    task = ScheduledTask(
        id=generate_ulid(),
        name=body.name,
        description=body.description,
        prompt=body.prompt,
        schedule_config=schedule_data,
        agent=body.agent,
        model=body.model,
        workspace=body.workspace,
        template_id=body.template_id,
        timeout_seconds=body.timeout_seconds,
        loop_max_iterations=body.loop_max_iterations,
        loop_preset=body.loop_preset,
    )
    db.add(task)
    await db.flush()

    scheduler = _get_scheduler(request)
    await scheduler.sync_task(task.id)

    await db.refresh(task)
    return AutomationResponse.model_validate(task)


@router.get("/automations/{task_id}", response_model=AutomationResponse)
async def get_automation(
    task_id: str,
    db: AsyncSession = Depends(get_db),
) -> AutomationResponse:
    """Get a single scheduled task."""
    task = (
        await db.execute(
            select(ScheduledTask).where(ScheduledTask.id == task_id)
        )
    ).scalar_one_or_none()
    if task is None:
        raise HTTPException(404, "Automation not found")
    return AutomationResponse.model_validate(task)


@router.patch("/automations/{task_id}", response_model=AutomationResponse)
async def update_automation(
    request: Request,
    task_id: str,
    body: AutomationUpdate,
    db: AsyncSession = Depends(get_db),
) -> AutomationResponse:
    """Update a scheduled task (partial)."""
    task = (
        await db.execute(
            select(ScheduledTask).where(ScheduledTask.id == task_id)
        )
    ).scalar_one_or_none()
    if task is None:
        raise HTTPException(404, "Automation not found")

    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        if field == "schedule_config" and value is not None:
            setattr(task, field, value.model_dump(exclude_none=True) if hasattr(value, "model_dump") else value)
        else:
            setattr(task, field, value)

    await db.flush()

    scheduler = _get_scheduler(request)
    await scheduler.sync_task(task.id)

    await db.refresh(task)
    return AutomationResponse.model_validate(task)


@router.delete("/automations/{task_id}")
async def delete_automation(
    task_id: str,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Delete a scheduled task and its run history. Idempotent."""
    task = (
        await db.execute(
            select(ScheduledTask).where(ScheduledTask.id == task_id)
        )
    ).scalar_one_or_none()
    if task is None:
        # Already deleted — return success (idempotent)
        return {"success": True}

    await db.execute(
        sa_delete(TaskRun).where(TaskRun.task_id == task_id)
    )
    await db.delete(task)
    return {"success": True}


# ------------------------------------------------------------------
# Execution
# ------------------------------------------------------------------


@router.post("/automations/{task_id}/run")
async def run_automation_now(
    request: Request,
    task_id: str,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Run a scheduled task immediately (on-demand).

    Launches execution in a background task and returns immediately
    so the frontend isn't blocked. The frontend polls for status updates.
    """
    import asyncio

    task = (
        await db.execute(
            select(ScheduledTask).where(ScheduledTask.id == task_id)
        )
    ).scalar_one_or_none()
    if task is None:
        raise HTTPException(404, "Automation not found")

    # Pre-set status to "running" so the frontend sees it immediately
    task.last_run_status = "running"
    await db.flush()

    scheduler = _get_scheduler(request)

    # Fire-and-forget: run in background so API returns immediately
    asyncio.create_task(
        scheduler.run_now(task_id),
        name=f"automation-run-{task_id[:12]}",
    )
    return {"status": "started"}


@router.get("/automations/{task_id}/runs", response_model=list[TaskRunResponse])
async def list_runs(
    task_id: str,
    db: AsyncSession = Depends(get_db),
    limit: int = 20,
    offset: int = 0,
) -> list[TaskRunResponse]:
    """Get execution history for a scheduled task."""
    result = await db.execute(
        select(TaskRun)
        .where(TaskRun.task_id == task_id)
        .order_by(TaskRun.time_created.desc())
        .limit(limit)
        .offset(offset)
    )
    runs = result.scalars().all()
    return [TaskRunResponse.model_validate(r) for r in runs]
