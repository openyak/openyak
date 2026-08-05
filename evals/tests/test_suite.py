from evals.suite import aggregate_structured_metrics, render_structured_metrics_row


def test_structured_metrics_use_explicit_eligible_denominators() -> None:
    aggregate = aggregate_structured_metrics([
        {
            "structured_attempt_at_1": 1,
            "tool_selection_at_1": 1,
            "strict_schema_valid_at_1": 1,
            "execution_success_at_1": 1,
            "semantic_evaluated_at_1": 1,
            "semantic_valid_at_1": 1,
            "repair_attempted_at_1": 0,
            "repair_success_at_1": 0,
            "repair_extra_tokens_at_1": 0,
            "repair_latency_ms_at_1": 0.0,
        },
        {
            "structured_attempt_at_1": 1,
            "tool_selection_at_1": 0,
            "strict_schema_valid_at_1": 0,
            "execution_success_at_1": 0,
            "semantic_evaluated_at_1": 1,
            "semantic_valid_at_1": 0,
            "repair_attempted_at_1": 1,
            "repair_success_at_1": 1,
            "repair_extra_tokens_at_1": 0,
            "repair_latency_ms_at_1": 0.25,
        },
        {"structured_attempt_at_1": 0},
    ])

    assert aggregate == {
        "eligible_attempts": 2,
        "tool_selection_rate": 0.5,
        "schema_valid_at_1_rate": 0.5,
        "execution_success_at_1_rate": 0.5,
        "semantic_evaluated_attempts": 2,
        "semantic_argument_accuracy": 0.5,
        "repair_attempts": 1,
        "repair_attempt_rate": 0.5,
        "repair_success_rate": 1.0,
        "average_repair_extra_tokens": 0.0,
        "average_repair_latency_ms": 0.25,
    }


def test_structured_markdown_row_is_rendered_from_aggregate_metrics() -> None:
    row = render_structured_metrics_row(
        label="realrouter / model-a / native",
        pass_rate=0.8,
        metrics={
            "eligible_attempts": 5,
            "tool_selection_rate": 0.8,
            "schema_valid_at_1_rate": 0.6,
            "execution_success_at_1_rate": 0.6,
            "semantic_evaluated_attempts": 2,
            "semantic_argument_accuracy": 0.5,
            "repair_attempts": 1,
            "repair_attempt_rate": 0.2,
            "repair_success_rate": 1.0,
            "average_repair_extra_tokens": 0.0,
            "average_repair_latency_ms": 0.25,
        },
    )

    assert row == (
        "| realrouter / model-a / native | 80.0% | 80.0% | 60.0% | "
        "60.0% | 50.0% | 20.0% | 100.0% | 0.00 | 0.250 ms |"
    )
