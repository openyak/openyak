from evals.structured import (
    ArgumentAssertion,
    evaluate_native_tool_call,
    evaluate_prompt_tool_output,
    evaluate_tool_call,
)


def test_nested_schema_failure_is_reported_without_argument_values() -> None:
    evaluation = evaluate_tool_call(
        expected_tool="submit_request",
        observed_tool="submit_request",
        arguments={"request": {"target": 123456789}},
        schema={
            "type": "object",
            "properties": {
                "request": {
                    "type": "object",
                    "properties": {"target": {"type": "string"}},
                    "required": ["target"],
                },
            },
            "required": ["request"],
        },
    )

    assert evaluation.parse_valid is True
    assert evaluation.tool_selection_valid is True
    assert evaluation.schema_valid is False
    assert evaluation.schema_errors[0].keyword == "type"
    assert evaluation.schema_errors[0].instance_path == ["request", "target"]
    assert "123456789" not in evaluation.model_dump_json()


def test_native_and_prompt_paths_use_the_same_result_schema() -> None:
    schema = {
        "type": "object",
        "properties": {"file_path": {"type": "string"}},
        "required": ["file_path"],
    }
    native = evaluate_native_tool_call(
        expected_tool="write",
        tool_call={"name": "write", "arguments": {"file_path": "result.txt"}},
        schema=schema,
    )
    prompt = evaluate_prompt_tool_output(
        expected_tool="write",
        text=(
            '<tool_call>{"name":"write","arguments":'
            '{"file_path":"result.txt"}}</tool_call>'
        ),
        schema=schema,
    )

    assert type(native) is type(prompt)
    assert native.model_dump() == prompt.model_dump()
    assert native.parse_valid is True


def test_workspace_output_path_normalizer_accepts_equivalent_safe_targets() -> None:
    assertion = ArgumentAssertion(
        path=["file_path"],
        equals="result.txt",
        normalizer="workspace_output_path",
    )
    schema = {
        "type": "object",
        "properties": {"file_path": {"type": "string"}},
        "required": ["file_path"],
    }

    prefixed = evaluate_tool_call(
        expected_tool="write",
        observed_tool="write",
        arguments={"file_path": "openyak_written/result.txt"},
        schema=schema,
        argument_assertions=[assertion],
    )
    absolute_output = evaluate_tool_call(
        expected_tool="write",
        observed_tool="write",
        arguments={"file_path": "/tmp/workspace/openyak_written/result.txt"},
        schema=schema,
        argument_assertions=[assertion],
    )
    absolute_workspace_root = evaluate_tool_call(
        expected_tool="write",
        observed_tool="write",
        arguments={"file_path": "/tmp/workspace/result.txt"},
        schema=schema,
        argument_assertions=[assertion],
    )

    assert prefixed.semantic_valid is True
    assert absolute_output.semantic_valid is True
    assert absolute_workspace_root.semantic_valid is False
