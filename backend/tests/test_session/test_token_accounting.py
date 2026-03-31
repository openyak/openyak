"""Token accounting invariants in session processor."""

from app.schemas.provider import ModelCapabilities, ModelInfo, ModelPricing
from app.session.utils import calculate_step_cost as _calculate_step_cost


def _model(prompt_per_million: float, completion_per_million: float) -> ModelInfo:
    return ModelInfo(
        id="test/model",
        name="test",
        provider_id="openrouter",
        capabilities=ModelCapabilities(),
        pricing=ModelPricing(
            prompt=prompt_per_million,
            completion=completion_per_million,
        ),
    )


def test_calculate_step_cost_includes_reasoning_in_completion_pricing():
    model = _model(prompt_per_million=2.0, completion_per_million=8.0)
    usage = {
        "input": 1_000,
        "output": 500,
        "reasoning": 500,
    }

    cost = _calculate_step_cost(usage, model)
    # 1000 * 2e-6 + (500 + 500) * 8e-6 = 0.002 + 0.008
    assert cost == 0.01


def test_calculate_step_cost_zero_when_pricing_unavailable():
    model = _model(prompt_per_million=0.0, completion_per_million=0.0)
    usage = {"input": 1000, "output": 1000, "reasoning": 1000}
    assert _calculate_step_cost(usage, model) == 0.0


def test_calculate_step_cost_direct_usd_no_markup():
    """Billing uses direct USD — no markup applied."""
    model = _model(prompt_per_million=2.0, completion_per_million=8.0)
    usage = {"input": 1_000, "output": 500, "reasoning": 500}

    cost = _calculate_step_cost(usage, model)
    assert cost == 0.01
