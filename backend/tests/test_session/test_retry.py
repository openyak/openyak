"""Retry module tests."""

import asyncio

import pytest

from app.session.retry import (
    MAX_RETRIES,
    is_retryable,
    retry_delay,
    sleep_with_abort,
)


class TestIsRetryable:
    def test_rate_limit(self):
        e = Exception("Rate limit exceeded")
        assert is_retryable(e) == "Rate limited"

    def test_429(self):
        e = Exception("Error 429: too many requests")
        assert is_retryable(e) == "Rate limited"

    def test_too_many_requests(self):
        e = Exception("too_many_requests")
        assert is_retryable(e) == "Rate limited"

    def test_server_500(self):
        e = Exception("Internal server error 500")
        assert is_retryable(e) is not None

    def test_server_502(self):
        e = Exception("502 Bad Gateway")
        assert is_retryable(e) is not None

    def test_timeout(self):
        e = Exception("Connection timeout")
        assert is_retryable(e) == "Network error"

    def test_network_error(self):
        e = Exception("network unreachable")
        assert is_retryable(e) == "Network error"

    def test_overloaded(self):
        e = Exception("Model is overloaded")
        assert is_retryable(e) == "Provider overloaded"

    def test_context_overflow_not_retryable(self):
        e = Exception("context_length_exceeded")
        assert is_retryable(e) is None

    def test_max_tokens_not_retryable(self):
        e = Exception("max_tokens exceeded for this model")
        assert is_retryable(e) is None

    def test_a_max_tokens_parameter_error_is_not_a_context_overflow(self):
        """Only the *input* being too large may route to reactive compaction.

        Providers reject an oversized completion budget with a 400 naming the
        `max_tokens` parameter. Reading that as overflow sends the session into
        a compaction loop that cannot fix it — compaction shrinks the input.
        """
        from app.session.retry import is_context_overflow

        for message in (
            "Invalid value for max_tokens: must be <= 4096",
            "400 Bad Request: max_tokens is required",
        ):
            error = Exception(message)
            assert is_context_overflow(error) is False, message
            assert is_retryable(error) is None, message

    def test_real_overflow_messages_still_route_to_compaction(self):
        from app.session.retry import is_context_overflow

        for message in (
            "This model maximum context length is 8192 tokens",
            "context_length_exceeded: too long",
            "prompt is too long: 250000 tokens > 200000 maximum",
            "input too long for this model",
            "Requested tokens exceed context limit of 128000",
        ):
            assert is_context_overflow(Exception(message)) is True, message

    def test_generic_error_not_retryable(self):
        e = Exception("Something unexpected happened")
        assert is_retryable(e) is None

    def test_input_too_long_not_retryable(self):
        e = Exception("input too long for context window")
        assert is_retryable(e) is None


class TestRetryDelay:
    def test_attempt_0(self):
        delay = retry_delay(0)
        # Should be BASE_DELAY (2.0) ± 20% jitter
        assert 1.5 <= delay <= 2.5

    def test_attempt_1(self):
        delay = retry_delay(1)
        # Should be 4.0 ± 20% jitter
        assert 3.0 <= delay <= 5.0

    def test_attempt_3_capped(self):
        delay = retry_delay(3)
        # Should be min(2.0 * 2^3 = 16.0, 30.0) ± 20%
        assert 12.0 <= delay <= 20.0

    def test_attempt_10_capped_at_max(self):
        delay = retry_delay(10)
        # Exponential would be huge but capped at 30s ± 20%
        assert delay <= 36.0

    def test_jitter_varies(self):
        """Multiple calls should produce different delays (jitter)."""
        delays = [retry_delay(1) for _ in range(20)]
        # Not all delays should be identical
        assert len(set(round(d, 2) for d in delays)) > 1


class TestSleepWithAbort:
    @pytest.mark.asyncio
    async def test_normal_sleep(self):
        """Sleep completes normally without abort."""
        aborted = await sleep_with_abort(0.01)
        assert aborted is False

    @pytest.mark.asyncio
    async def test_abort_interrupts(self):
        """Setting abort event wakes sleep early."""
        abort = asyncio.Event()

        async def set_abort():
            await asyncio.sleep(0.01)
            abort.set()

        asyncio.create_task(set_abort())
        aborted = await sleep_with_abort(10.0, abort)
        assert aborted is True

    @pytest.mark.asyncio
    async def test_no_abort_event(self):
        """Works without abort event."""
        aborted = await sleep_with_abort(0.01, None)
        assert aborted is False
