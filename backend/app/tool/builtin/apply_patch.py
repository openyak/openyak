"""Apply-patch tool — apply a lightweight patch to create, update, or delete files."""

from __future__ import annotations

import os
from typing import Any

from app.tool.base import ToolDefinition, ToolResult
from app.tool.builtin.patch_parser import HunkType, apply_chunks, parse_patch
from app.tool.context import ToolContext
from app.tool.workspace import WorkspaceViolation, resolve_for_write
from app.utils.diff import generate_unified_diff


class ApplyPatchTool(ToolDefinition):

    @property
    def id(self) -> str:
        return "apply_patch"

    @property
    def description(self) -> str:
        return (
            "Apply a patch to create, update, or delete files. "
            "Uses a lightweight format:\n"
            "*** Begin Patch\n"
            "*** Add File: path\n"
            "+new line\n"
            "*** Update File: path\n"
            "@@ context line\n"
            "-old line\n"
            "+new line\n"
            "*** Update File: old/path\n"
            "*** Move to: new/path\n"
            "*** Delete File: path\n"
            "*** End Patch\n\n"
            "Use paths relative to the output directory, such as added.txt; "
            "an explicit openyak_written/ prefix is also accepted without duplication. "
            "More token-efficient than individual edit calls for multi-file changes."
        )

    def parameters_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "patch_text": {
                    "type": "string",
                    "description": (
                        "The patch content in *** Begin/End Patch format. "
                        "File paths are relative to the output directory. "
                        "Rename with *** Update File: old/path followed by "
                        "*** Move to: new/path."
                    ),
                },
            },
            "required": ["patch_text"],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        patch_text = args["patch_text"]

        # Parse the patch
        parsed = parse_patch(patch_text)
        if parsed.errors and not parsed.hunks:
            return ToolResult(error="Patch parse errors: " + "; ".join(parsed.errors))

        if not parsed.hunks:
            return ToolResult(error="No file operations found in patch")

        # Validate all paths first before making any changes
        resolved_paths: list[tuple[str, str | None]] = []  # (resolved_path, move_to)
        for hunk in parsed.hunks:
            try:
                resolved = resolve_for_write(hunk.path, ctx.workspace)
                move_to = None
                if hunk.move_to:
                    move_to = resolve_for_write(hunk.move_to, ctx.workspace)
                resolved_paths.append((resolved, move_to))
            except WorkspaceViolation as e:
                return ToolResult(error=str(e))

        # Apply each hunk
        summaries: list[str] = []
        diffs: list[str] = []

        for hunk, (resolved, move_to) in zip(parsed.hunks, resolved_paths):
            if hunk.type == HunkType.ADD:
                # Create new file
                parent = os.path.dirname(resolved)
                if parent:
                    os.makedirs(parent, exist_ok=True)
                if os.path.exists(resolved):
                    return ToolResult(
                        error=f"Cannot add file '{hunk.path}': already exists"
                    )
                with open(resolved, "w", encoding="utf-8", newline="\n") as f:
                    f.write(hunk.contents)
                summaries.append(f"+ Added {hunk.path}")

            elif hunk.type == HunkType.DELETE:
                if not os.path.exists(resolved):
                    return ToolResult(
                        error=f"Cannot delete file '{hunk.path}': not found"
                    )
                os.remove(resolved)
                summaries.append(f"- Deleted {hunk.path}")

            elif hunk.type == HunkType.UPDATE:
                if not os.path.exists(resolved):
                    return ToolResult(
                        error=f"Cannot update file '{hunk.path}': not found"
                    )
                try:
                    with open(resolved, "r", encoding="utf-8") as f:
                        original = f.read()
                except UnicodeDecodeError:
                    return ToolResult(
                        error=f"Cannot update binary file: {hunk.path}"
                    )

                modified = apply_chunks(original, hunk.chunks)
                diff = generate_unified_diff(original, modified, hunk.path)
                if diff:
                    diffs.append(diff)

                target = move_to if move_to else resolved
                if move_to:
                    parent = os.path.dirname(move_to)
                    if parent:
                        os.makedirs(parent, exist_ok=True)
                    # Delete original after writing new
                    with open(target, "w", encoding="utf-8", newline="\n") as f:
                        f.write(modified)
                    if resolved != target:
                        os.remove(resolved)
                    label = f"~ Updated {hunk.path} → {hunk.move_to}"
                else:
                    with open(target, "w", encoding="utf-8", newline="\n") as f:
                        f.write(modified)
                    label = f"~ Updated {hunk.path}"

                summaries.append(label)

        output_parts = summaries.copy()
        if diffs:
            output_parts.append("")
            output_parts.extend(diffs)

        warnings = ""
        if parsed.errors:
            warnings = "\nWarnings: " + "; ".join(parsed.errors)

        return ToolResult(
            output="\n".join(output_parts) + warnings,
            title=f"Applied patch ({len(parsed.hunks)} file{'s' if len(parsed.hunks) != 1 else ''})",
            metadata={"files": len(parsed.hunks)},
        )
