"""SSE event types and encoding."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class SSEEvent:
    """A single Server-Sent Event."""

    event: str  # event type name
    data: dict[str, Any] = field(default_factory=dict)
    id: int | None = None  # monotonic event ID for replay

    def encode(self) -> str:
        """Encode as SSE wire format."""
        lines = []
        if self.id is not None:
            lines.append(f"id: {self.id}")
        lines.append(f"event: {self.event}")
        lines.append(f"data: {json.dumps(self.data, default=str)}")
        lines.append("")  # trailing newline
        return "\n".join(lines) + "\n"


# Event type constants — hyphen style, mirrors OpenCode's event names
TEXT_DELTA = "text-delta"
REASONING_DELTA = "reasoning-delta"
TOOL_START = "tool-call"        # renamed: was tool_start, matches OpenCode's "tool-call"
TOOL_RESULT = "tool-result"
TOOL_ERROR = "tool-error"
STEP_START = "step-start"
STEP_FINISH = "step-finish"
COMPACTED = "compacted"
COMPACTION_START = "compaction-start"
COMPACTION_PHASE = "compaction-phase"
COMPACTION_PROGRESS = "compaction-progress"
COMPACTION_ERROR = "compaction-error"
PERMISSION_REQUEST = "permission-request"
QUESTION = "question"
TITLE_UPDATE = "title-update"
RETRY = "retry"
DESYNC = "desync"
DONE = "done"
AGENT_ERROR = "agent-error"
PLAN_REVIEW = "plan-review"
MODEL_LOADING = "model-loading"
PERMISSION_RESOLVED = "permission-resolved"
QUESTION_RESOLVED = "question-resolved"
TASK_BATCH_START = "task-batch-start"
TASK_BATCH_UPDATE = "task-batch-update"
TASK_BATCH_FINISH = "task-batch-finish"
