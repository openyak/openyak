# Context window limited to about 43k on long-context models
**Status**: active | **Created**: 2026-05-09 | **Tags**: session, compaction, context-window

## Symptoms
Models advertised with large context windows, such as 128k or 256k, compact or truncate much earlier than expected. A 128k model can appear limited to roughly 43k tokens.

## Root Cause
The provider registry auto-derived `effective_context_window` for every model as 33% of the advertised context window, so compaction and UI usage were based on a reduced synthetic limit.

## Fix
Use the model's full advertised context by default, keep `effective_context_window` only for explicit provider overrides, and trigger compaction at 90% of usable context after output and reserve budgets are subtracted.

## Prevention
- [x] Test added? `backend/tests/test_session/test_utils.py`, `backend/tests/test_session/test_compaction.py`
- [ ] Lint catches it?
- [ ] Gotcha updated?
