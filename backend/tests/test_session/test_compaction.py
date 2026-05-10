"""Compaction tests."""

from app.session.compaction import should_compact


class TestShouldCompact:
    def test_below_threshold(self):
        usage = {"input": 1000, "output": 500}
        assert not should_compact(usage, model_max_context=128_000)

    def test_above_threshold(self):
        usage = {"input": 120_000, "output": 5_000}
        assert should_compact(usage, model_max_context=128_000, reserved=20_000)

    def test_below_output_safe_threshold(self):
        usage = {"input": 99_807, "output": 0}
        # usable = 128000 - 8192(effective_output) - 20000(reserved) = 99808
        assert not should_compact(usage, model_max_context=128_000, reserved=20_000)

    def test_over_output_safe_threshold(self):
        usage = {"input": 99_809, "output": 0}
        assert should_compact(usage, model_max_context=128_000, reserved=20_000)

    def test_proactive_threshold_uses_eighty_five_percent_context(self):
        usage = {"input": 108_800, "output": 0}
        assert should_compact(
            usage,
            model_max_context=128_000,
            model_max_output=512,
        )

    def test_below_proactive_threshold_when_output_reserve_allows_more(self):
        usage = {"input": 108_799, "output": 0}
        assert not should_compact(
            usage,
            model_max_context=128_000,
            model_max_output=512,
        )

    def test_large_context_model_compacts_at_eighty_five_percent(self):
        usage = {"input": 892_500, "output": 0}
        assert should_compact(
            usage,
            model_max_context=1_050_000,
            model_max_output=128_000,
        )

    def test_empty_usage(self):
        assert not should_compact({}, model_max_context=128_000)

    def test_small_model(self):
        usage = {"input": 3500, "output": 500}
        assert should_compact(usage, model_max_context=4096, model_max_output=512, reserved=500)

    def test_uses_reported_total_when_present(self):
        usage = {
            "input": 10,
            "output": 10,
            "reasoning": 10,
            "cache_read": 10,
            "total": 108_001,
        }
        assert should_compact(usage, model_max_context=128_000, reserved=20_000)

    def test_includes_reasoning_and_cache_read_in_fallback_total(self):
        usage = {
            "input": 107_900,
            "output": 0,
            "reasoning": 50,
            "cache_read": 100,
        }
        assert should_compact(usage, model_max_context=128_000, reserved=20_000)
