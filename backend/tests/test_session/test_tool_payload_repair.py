from app.session.utils import repair_tool_call_payload as _repair_tool_call_payload


def test_repair_tool_payload_from_function_array_shape():
    tool_name, tool_args = _repair_tool_call_payload(
        "",
        [
            {
                "type": "function",
                "function": {
                    "name": "web_search",
                    "parameters": {
                        "query": "nasdaq today",
                        "max_results": 5,
                    },
                },
            }
        ],
    )

    assert tool_name == "web_search"
    assert tool_args == {"query": "nasdaq today", "max_results": 5}


def test_repair_tool_payload_from_parameters_wrapper():
    tool_name, tool_args = _repair_tool_call_payload(
        "web_search",
        {
            "parameters": {
                "query": "nasdaq close",
                "max_results": 3,
            }
        },
    )

    assert tool_name == "web_search"
    assert tool_args == {"query": "nasdaq close", "max_results": 3}
