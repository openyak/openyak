"""Tool argument schema validation tests."""

import pytest

from app.schemas.agent import AgentInfo
from app.tool.builtin.apply_patch import ApplyPatchTool
from app.tool.builtin.read import ReadTool
from app.tool.builtin.bash import BashTool
from app.tool.builtin.code_execute import CodeExecuteTool
from app.tool.builtin.edit import EditTool  # now supports single + batch modes
from app.tool.builtin.glob_tool import GlobTool
from app.tool.context import ToolContext


def _make_ctx() -> ToolContext:
    return ToolContext(
        session_id="test-session",
        message_id="test-msg",
        agent=AgentInfo(name="test", description="", mode="primary"),
        call_id="test-call",
    )


class TestSchemaValidation:
    """Test that validate_args catches bad arguments."""

    def test_read_valid(self):
        tool = ReadTool()
        assert tool.validate_args({"file_path": "/tmp/test.txt"}) is None

    def test_read_missing_required(self):
        tool = ReadTool()
        error = tool.validate_args({})
        assert error is not None
        assert "file_path" in error

    def test_read_wrong_type(self):
        tool = ReadTool()
        error = tool.validate_args({"file_path": 123})
        assert error is not None
        assert "string" in error

    def test_bash_valid(self):
        tool = BashTool()
        assert tool.validate_args({"command": "echo hello"}) is None

    def test_bash_missing_command(self):
        tool = BashTool()
        error = tool.validate_args({})
        assert error is not None
        assert "command" in error

    def test_edit_valid_single(self):
        tool = EditTool()
        assert tool.validate_args({
            "file_path": "/tmp/test.txt",
            "old_string": "hello",
            "new_string": "world",
        }) is None

    def test_edit_valid_batch(self):
        tool = EditTool()
        assert tool.validate_args({
            "file_path": "/tmp/test.txt",
            "edits": [{"old_string": "hello", "new_string": "world"}],
        }) is None

    def test_edit_conflicting_modes_are_schema_invalid(self):
        tool = EditTool()

        error = tool.validate_args({
            "file_path": "/tmp/test.txt",
            "old_string": "hello",
            "new_string": "world",
            "edits": [{"old_string": "hello", "new_string": "world"}],
        })

        assert error is not None
        assert "either" in error.lower()

    def test_edit_schema_advertises_mutually_exclusive_modes(self):
        parameters = EditTool().to_openai_spec()["function"]["parameters"]

        assert len(parameters["oneOf"]) == 2
        assert parameters["oneOf"][0]["required"] == ["old_string", "new_string"]
        assert parameters["oneOf"][1]["required"] == ["edits"]

    @pytest.mark.parametrize(
        "args",
        [
            {"file_path": "/tmp/test.txt"},
            {"file_path": "/tmp/test.txt", "old_string": "hello"},
            {"file_path": "/tmp/test.txt", "new_string": "world"},
            {"file_path": "/tmp/test.txt", "edits": []},
        ],
    )
    def test_edit_requires_one_complete_nonempty_mode(self, args):
        assert EditTool().validate_args(args) is not None

    @pytest.mark.parametrize(
        "edit",
        [
            {},
            {"old_string": "hello"},
            {"new_string": "world"},
            {"old_string": 1, "new_string": "world"},
        ],
    )
    def test_edit_batch_validates_each_nested_replacement(self, edit):
        error = EditTool().validate_args({
            "file_path": "/tmp/test.txt",
            "edits": [edit],
        })

        assert error is not None
        assert "edit 1" in error.lower()

    def test_edit_missing_file_path(self):
        tool = EditTool()
        error = tool.validate_args({
            "old_string": "hello",
            "new_string": "world",
        })
        assert error is not None
        assert "file_path" in error

    def test_glob_valid(self):
        tool = GlobTool()
        assert tool.validate_args({"pattern": "*.py"}) is None

    def test_glob_missing_pattern(self):
        tool = GlobTool()
        error = tool.validate_args({})
        assert error is not None
        assert "pattern" in error

    def test_extra_fields_allowed(self):
        """Extra fields should not cause validation error."""
        tool = ReadTool()
        assert tool.validate_args({"file_path": "/tmp/test.txt", "extra": "value"}) is None

    def test_apply_patch_advertises_move_syntax(self):
        description = ApplyPatchTool().to_openai_spec()["function"]["description"]

        assert "*** Move to: new/path" in description

    def test_mutating_tools_advertise_the_output_directory_contract(self):
        bash_spec = BashTool().to_openai_spec()["function"]
        code_spec = CodeExecuteTool().to_openai_spec()["function"]
        edit_spec = EditTool().to_openai_spec()["function"]
        patch_spec = ApplyPatchTool().to_openai_spec()["function"]

        assert "omit cwd" in bash_spec["description"]
        assert "openyak_written" in bash_spec["description"]
        assert "Python variables, not environment variables" in code_spec["description"]
        assert "openyak_written" in edit_spec["parameters"]["properties"]["file_path"]["description"]
        assert "relative to the output directory" in patch_spec["description"]


class TestValidationInExecution:
    """Test that __call__ returns error for invalid args (not crash)."""

    @pytest.mark.asyncio
    async def test_missing_required_returns_error(self):
        tool = ReadTool()
        result = await tool({}, _make_ctx())
        assert result.error is not None
        assert "file_path" in result.error

    @pytest.mark.asyncio
    async def test_wrong_type_returns_error(self):
        tool = BashTool()
        result = await tool({"command": 42}, _make_ctx())
        assert result.error is not None
        assert "string" in result.error

    @pytest.mark.asyncio
    async def test_valid_args_pass_through(self):
        tool = GlobTool()
        # Valid args should not return a validation error
        result = await tool({"pattern": "*.nonexistent_extension"}, _make_ctx())
        # Should succeed (even if no files found)
        assert result.error is None or "Invalid arguments" not in (result.error or "")
