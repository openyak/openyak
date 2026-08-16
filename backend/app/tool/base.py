"""Tool definition base class and result types."""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal

from app.tool.truncation import truncate_output

logger = logging.getLogger(__name__)

# JSON Schema type → Python types mapping for validation
_TYPE_MAP: dict[str, tuple[type, ...]] = {
    "string": (str,),
    "number": (int, float),
    "integer": (int,),
    "boolean": (bool,),
    "array": (list,),
    "object": (dict,),
}


@dataclass
class ToolResult:
    """Result of a tool execution."""

    output: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    title: str | None = None
    error: str | None = None
    attachments: list[dict[str, Any]] = field(default_factory=list)
    """File attachments to be persisted as FileParts on the assistant message.

    Each entry: {type, path?, url?, mime_type?, name?}
    Mirrors OpenCode's Tool.execute() return value attachments field.
    """

    @property
    def success(self) -> bool:
        return self.error is None


class ToolDefinition(ABC):
    """Abstract base for all tools.

    Subclasses implement:
      - id: unique tool identifier
      - description: human-readable description
      - parameters_schema(): JSON Schema for tool arguments
      - execute(args, ctx): actual tool logic
    """

    @property
    @abstractmethod
    def id(self) -> str:
        """Unique tool identifier (e.g. 'read', 'bash', 'grep')."""

    @property
    @abstractmethod
    def description(self) -> str:
        """Human-readable description of what the tool does."""

    @property
    def is_concurrency_safe(self) -> bool:
        """Whether this tool can run in parallel with other concurrent-safe tools.

        Override to True for read-only tools (read, glob, grep, etc.).
        Exclusive (False) tools run one at a time to avoid conflicts.
        Inspired by Claude Code's StreamingToolExecutor concurrency model.
        """
        return False

    @property
    def execution_timeout(self) -> float | None:
        """Optional Tool-specific timeout; ``None`` uses the global limit."""
        return None

    @property
    def truncation_direction(self) -> Literal["head", "tail"]:
        """Which end of an oversized result to keep.

        ``head`` suits tools whose output is ordered by relevance — a search
        result list, a file read from the top. ``tail`` suits anything whose
        conclusion is at the end: a failed build reports its error on the last
        lines, and keeping the first 2000 lines of setup noise drops the one
        thing the model needed.
        """
        return "head"

    @abstractmethod
    def parameters_schema(self) -> dict[str, Any]:
        """Return JSON Schema for the tool's parameters."""

    @abstractmethod
    async def execute(self, args: dict[str, Any], ctx: "ToolContext") -> ToolResult:
        """Execute the tool with given arguments and context."""

    def validate_args(self, args: dict[str, Any]) -> str | None:
        """Validate arguments against parameters_schema.

        Returns error message if invalid, None if valid.
        Lightweight validation: checks required fields and basic types
        without needing the jsonschema library.
        """
        schema = self.parameters_schema()
        properties = schema.get("properties", {})
        required = schema.get("required", [])

        # Check required fields
        for field_name in required:
            if field_name not in args:
                return f"Missing required parameter: '{field_name}'"

        # Check types for provided fields
        for key, value in args.items():
            if key not in properties:
                continue  # Extra fields are OK
            prop = properties[key]
            expected_type = prop.get("type")
            if expected_type and expected_type in _TYPE_MAP:
                if not isinstance(value, _TYPE_MAP[expected_type]):
                    return (
                        f"Parameter '{key}': expected {expected_type}, "
                        f"got {type(value).__name__}"
                    )

            # Enum constraints
            enum_values = prop.get("enum")
            if enum_values and value not in enum_values:
                return f"Parameter '{key}': must be one of {enum_values}, got '{value}'"

        return None

    async def __call__(self, args: dict[str, Any], ctx: "ToolContext") -> ToolResult:
        """Validate, execute, and truncate."""
        try:
            # Schema validation — catch LLM hallucinated arguments early
            validation_error = self.validate_args(args)
            if validation_error:
                return ToolResult(error=f"Invalid arguments for {self.id}: {validation_error}")

            result = await self.execute(args, ctx)
            # Truncate output — save full text to file if oversized
            # Mirrors OpenCode's Truncate.output() integration in tool/tool.ts
            # Check if agent has "task" tool for smarter hints
            has_task = not ctx.agent.tools or "task" in ctx.agent.tools
            if result.output:
                tr = truncate_output(
                    result.output,
                    workspace=ctx.workspace,
                    has_task_tool=has_task,
                    direction=self.truncation_direction,
                )
                result.output = tr.content
                if tr.truncated:
                    result.metadata["truncated"] = True
                    result.metadata["output_path"] = tr.output_path
            if result.error:
                # An error is model-visible context like any other, and an
                # unbounded one (a stack trace, a dumped response body) eats the
                # window the same way an unbounded output would.
                error_tr = truncate_output(
                    result.error,
                    workspace=ctx.workspace,
                    has_task_tool=has_task,
                    direction=self.truncation_direction,
                )
                result.error = error_tr.content
            return result
        except Exception as e:
            logger.exception("Tool %s failed", self.id)
            # Bound this the same way as a returned error: an exception's repr
            # can carry a whole response body.
            failure = truncate_output(
                str(e),
                workspace=getattr(ctx, "workspace", None),
                direction=self.truncation_direction,
            )
            return ToolResult(error=failure.content)

    def to_openai_spec(self) -> dict[str, Any]:
        """Convert to OpenAI function calling format."""
        return {
            "type": "function",
            "function": {
                "name": self.id,
                "description": self.description,
                "parameters": self.parameters_schema(),
            },
        }


# Forward reference resolved at import time
from app.tool.context import ToolContext  # noqa: E402
