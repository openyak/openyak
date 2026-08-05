"""Deterministic, privacy-safe scoring for generated tool calls."""

from __future__ import annotations

from typing import Any, Literal

from jsonschema import Draft202012Validator
from pydantic import BaseModel, ConfigDict, Field

from app.provider.tool_calling.prompt_based import parse_tool_calls


class SchemaError(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keyword: str
    instance_path: list[str | int] = Field(default_factory=list)
    schema_path: list[str | int] = Field(default_factory=list)


class ArgumentAssertion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: list[str | int]
    equals: Any
    normalizer: Literal["workspace_output_path"] | None = None


class ToolCallEvaluation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    parse_valid: bool
    tool_selection_valid: bool
    schema_valid: bool
    schema_errors: list[SchemaError] = Field(default_factory=list)
    semantic_valid: bool | None = None
    semantic_error_paths: list[list[str | int]] = Field(default_factory=list)


def evaluate_tool_call(
    *,
    expected_tool: str,
    observed_tool: Any,
    arguments: Any,
    schema: dict[str, Any],
    argument_assertions: list[ArgumentAssertion] | None = None,
) -> ToolCallEvaluation:
    """Score one call without retaining any argument values."""
    parse_valid = (
        isinstance(observed_tool, str)
        and bool(observed_tool)
        and isinstance(arguments, dict)
    )
    tool_selection_valid = parse_valid and observed_tool == expected_tool
    errors: list[SchemaError] = []
    if parse_valid:
        validator = Draft202012Validator(schema)
        for error in sorted(
            validator.iter_errors(arguments),
            key=lambda item: (list(item.absolute_path), list(item.absolute_schema_path)),
        ):
            errors.append(SchemaError(
                keyword=str(error.validator),
                instance_path=list(error.absolute_path),
                schema_path=list(error.absolute_schema_path),
            ))
    semantic_valid: bool | None = None
    semantic_error_paths: list[list[str | int]] = []
    if argument_assertions and parse_valid and tool_selection_valid and not errors:
        semantic_valid = True
        for assertion in argument_assertions:
            observed = _value_at_path(arguments, assertion.path)
            expected = assertion.equals
            if assertion.normalizer == "workspace_output_path":
                observed = _normalize_workspace_output_path(observed)
                expected = _normalize_workspace_output_path(expected)
            if observed != expected:
                semantic_valid = False
                semantic_error_paths.append(assertion.path)
    return ToolCallEvaluation(
        parse_valid=parse_valid,
        tool_selection_valid=tool_selection_valid,
        schema_valid=parse_valid and not errors,
        schema_errors=errors,
        semantic_valid=semantic_valid,
        semantic_error_paths=semantic_error_paths,
    )


def evaluate_native_tool_call(
    *,
    expected_tool: str,
    tool_call: dict[str, Any] | None,
    schema: dict[str, Any],
    argument_assertions: list[ArgumentAssertion] | None = None,
) -> ToolCallEvaluation:
    """Normalize one native function call into the canonical scorer result."""
    call = tool_call or {}
    return evaluate_tool_call(
        expected_tool=expected_tool,
        observed_tool=call.get("name"),
        arguments=call.get("arguments"),
        schema=schema,
        argument_assertions=argument_assertions,
    )


def evaluate_prompt_tool_output(
    *,
    expected_tool: str,
    text: str,
    schema: dict[str, Any],
    argument_assertions: list[ArgumentAssertion] | None = None,
) -> ToolCallEvaluation:
    """Normalize the first prompt-tag tool call into the canonical result."""
    _, tool_calls = parse_tool_calls(text)
    return evaluate_native_tool_call(
        expected_tool=expected_tool,
        tool_call=tool_calls[0] if tool_calls else None,
        schema=schema,
        argument_assertions=argument_assertions,
    )


_MISSING = object()


def _value_at_path(value: Any, path: list[str | int]) -> Any:
    current = value
    for part in path:
        if isinstance(part, str) and isinstance(current, dict) and part in current:
            current = current[part]
        elif (
            isinstance(part, int)
            and isinstance(current, list)
            and 0 <= part < len(current)
        ):
            current = current[part]
        else:
            return _MISSING
    return current


def _normalize_workspace_output_path(value: Any) -> Any:
    """Normalize paths that resolve to the workspace output directory."""
    if not isinstance(value, str):
        return value
    normalized = value.replace("\\", "/")
    parts = normalized.split("/")
    if "openyak_written" in parts:
        return "/".join(parts[parts.index("openyak_written") + 1:])
    if not normalized.startswith("/") and not (
        len(normalized) >= 3
        and normalized[1] == ":"
        and normalized[2] == "/"
    ):
        return normalized.removeprefix("./")
    return normalized
