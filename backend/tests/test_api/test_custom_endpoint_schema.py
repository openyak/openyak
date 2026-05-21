"""Tests for the custom-endpoint Pydantic schemas.

Covers slug validation (POST), header validation (POST full-set), and
the headers JSON Merge Patch delta validation (PATCH).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas.provider import (
    CustomEndpointCreate,
    CustomEndpointModel,
    CustomEndpointUpdate,
    RESERVED_CUSTOM_SLUGS,
)


# ---------------------------------------------------------------------------
# Slug validation
# ---------------------------------------------------------------------------


class TestSlugValidation:
    def _make(self, slug: str, **kwargs):
        return CustomEndpointCreate(
            slug=slug,
            name=kwargs.pop("name", "My Provider"),
            base_url=kwargs.pop("base_url", "https://api.example.com/v1"),
            **kwargs,
        )

    def test_simple_slug(self):
        assert self._make("myprovider").slug == "myprovider"

    def test_alphanumeric(self):
        assert self._make("groq3").slug == "groq3"

    def test_hyphens_and_underscores(self):
        assert self._make("my-cool_provider").slug == "my-cool_provider"

    def test_max_length(self):
        slug = "a" + "b" * 49  # 50 chars total
        assert self._make(slug).slug == slug

    def test_uppercase_lowered(self):
        """Mixed case in input is lowered by the validator (after strip)."""
        # The validator both strips and lowercases before applying the
        # regex; "Foo" → "foo" is accepted.
        assert self._make("Foo").slug == "foo"

    def test_surrounding_whitespace_stripped(self):
        assert self._make("  myslug  ").slug == "myslug"

    @pytest.mark.parametrize("slug", sorted(RESERVED_CUSTOM_SLUGS))
    def test_rejects_reserved(self, slug: str):
        with pytest.raises(ValidationError, match="reserved"):
            self._make(slug)

    @pytest.mark.parametrize(
        "slug",
        [
            "-leading-hyphen",      # starts with hyphen
            "_leading-underscore",  # starts with underscore
            "has space",            # space
            "has:colon",            # colon
            "has/slash",            # slash
            "has.dot",              # dot
            "has@at",               # @
            "你好",                 # non-ASCII
            "a" * 51,               # too long
            "",                     # empty (Field min_length=1)
        ],
    )
    def test_rejects_invalid_format(self, slug: str):
        with pytest.raises(ValidationError):
            self._make(slug)

    def test_pdef_catalog_keys_are_reserved(self):
        """Every BYOK provider id must round-trip into the reserved set,
        so a user can't accidentally shadow a built-in provider."""
        from app.provider.catalog import PROVIDER_CATALOG
        for pid in PROVIDER_CATALOG:
            with pytest.raises(ValidationError, match="reserved"):
                self._make(pid)


# ---------------------------------------------------------------------------
# Header validation — full-set semantics on POST
# ---------------------------------------------------------------------------


def _make_create(**kwargs) -> CustomEndpointCreate:
    return CustomEndpointCreate(
        slug=kwargs.pop("slug", "myprovider"),
        name=kwargs.pop("name", "My Provider"),
        base_url=kwargs.pop("base_url", "https://api.example.com/v1"),
        **kwargs,
    )


class TestHeadersCreate:
    def test_empty_dict(self):
        assert _make_create(headers={}).headers == {}

    def test_default_empty(self):
        assert _make_create().headers == {}

    def test_basic_pair(self):
        body = _make_create(headers={"X-Org": "acme"})
        assert body.headers == {"X-Org": "acme"}

    def test_strips_surrounding_whitespace_in_name(self):
        body = _make_create(headers={"  X-Org  ": "acme"})
        assert "X-Org" in body.headers

    @pytest.mark.parametrize("forbidden", ["host", "Host", "HOST", "Content-Length", "transfer-encoding"])
    def test_rejects_forbidden_names(self, forbidden: str):
        with pytest.raises(ValidationError, match="reserved"):
            _make_create(headers={forbidden: "x"})

    @pytest.mark.parametrize(
        "bad_name",
        [
            "X Bad",   # space
            "X:Bad",   # colon
            "X\nBad",  # newline
            "X\rBad",  # carriage return
            "X\tBad",  # tab
            "",        # empty
        ],
    )
    def test_rejects_bad_name_chars(self, bad_name: str):
        with pytest.raises(ValidationError):
            _make_create(headers={bad_name: "x"})

    @pytest.mark.parametrize(
        "bad_value",
        ["line1\nline2", "line1\rline2", "has\0null"],
    )
    def test_rejects_control_chars_in_value(self, bad_value: str):
        with pytest.raises(ValidationError, match="control characters"):
            _make_create(headers={"X-Bad": bad_value})

    def test_rejects_long_value(self):
        with pytest.raises(ValidationError, match="4096"):
            _make_create(headers={"X-Big": "x" * 5000})

    def test_at_length_limit(self):
        """Exactly 4096 chars should be accepted."""
        ok = _make_create(headers={"X-Big": "x" * 4096})
        assert len(ok.headers["X-Big"]) == 4096

    def test_rejects_non_string_value(self):
        with pytest.raises(ValidationError):
            _make_create(headers={"X-Org": 42})  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Header delta — JSON Merge Patch semantics on PATCH
# ---------------------------------------------------------------------------


class TestHeadersDelta:
    def test_omitted_field_is_none(self):
        """When the client doesn't send `headers` at all, the value is
        None — that's the "no change" signal the PATCH handler reads."""
        assert CustomEndpointUpdate().headers is None

    def test_empty_dict_kept_empty(self):
        """`{}` is preserved as-is (semantically: an empty delta, which
        the handler treats as no-op merge)."""
        assert CustomEndpointUpdate(headers={}).headers == {}

    def test_upsert_only(self):
        u = CustomEndpointUpdate(headers={"X-Org": "acme"})
        assert u.headers == {"X-Org": "acme"}

    def test_delete_only(self):
        """``null`` value marks the key for deletion."""
        u = CustomEndpointUpdate(headers={"X-Old": None})
        assert u.headers == {"X-Old": None}

    def test_mixed_upsert_and_delete(self):
        u = CustomEndpointUpdate(
            headers={"X-New": "v", "X-Old": None, "X-Keep": "v2"},
        )
        assert u.headers == {"X-New": "v", "X-Old": None, "X-Keep": "v2"}

    def test_delete_does_not_validate_value_length(self):
        """``None`` skips the value validator — useful so delete-only
        deltas don't need a body."""
        u = CustomEndpointUpdate(headers={"X-Big": None})
        assert u.headers == {"X-Big": None}

    def test_rejects_forbidden_name_even_with_null(self):
        """A null value still has to obey the name rules."""
        with pytest.raises(ValidationError, match="reserved"):
            CustomEndpointUpdate(headers={"Host": None})

    def test_rejects_control_chars_in_upsert_value(self):
        with pytest.raises(ValidationError, match="control characters"):
            CustomEndpointUpdate(headers={"X-Bad": "line1\nline2"})

    def test_rejects_long_upsert_value(self):
        with pytest.raises(ValidationError, match="4096"):
            CustomEndpointUpdate(headers={"X-Big": "x" * 5000})


# ---------------------------------------------------------------------------
# Models list
# ---------------------------------------------------------------------------


class TestCustomEndpointModel:
    def test_id_only(self):
        m = CustomEndpointModel(id="gpt-5")
        assert m.id == "gpt-5"
        assert m.name is None

    def test_id_and_name(self):
        m = CustomEndpointModel(id="gpt-5", name="GPT-5")
        assert m.name == "GPT-5"

    def test_id_min_length(self):
        with pytest.raises(ValidationError):
            CustomEndpointModel(id="")

    def test_id_max_length(self):
        with pytest.raises(ValidationError):
            CustomEndpointModel(id="x" * 201)
