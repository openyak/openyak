# Image attachments ignored by non-vision models
**Status**: active | **Created**: 2026-05-09 | **Tags**: frontend, provider, vision, attachments

## Symptoms
Attaching an image and asking what the assistant sees can produce a text-only answer where the model did not actually receive the image. Providing an image path can also lead the model to guess image contents.

## Root Cause
Image content was silently stripped for models whose metadata did not mark them as vision-capable, and OpenRouter vision detection did not read `architecture.input_modalities`.

## Fix
Detect OpenRouter vision support from `architecture.input_modalities`, block image sends for non-vision or unknown models in the frontend and backend, and stop tool/image handoff with a clear `MODEL_DOES_NOT_SUPPORT_IMAGES` error instead of stripping image blocks.

## Prevention
- [x] Test added? `backend/tests/test_provider/test_openrouter.py`, `backend/tests/test_session/test_utils.py`
- [x] Lint catches it? TypeScript checks cover the frontend request shape.
- [ ] Gotcha updated?
