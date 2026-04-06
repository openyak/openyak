# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

## [1.0.5] - 2026-04-06

### Added

- **desktop:** Linux desktop support with Wayland/X11 automatic detection and GBM buffer compatibility
- **ci:** Linux build pipeline producing `.deb` and `.rpm` packages
- **backend:** Custom OpenAI-compatible endpoint support — CRUD API, frontend settings panel, SSRF validation, prefix-based model filtering
- **frontend:** i18n support for custom endpoint UI (English and Chinese)

### Changed

- **assets:** Optimized all application icons and images for smaller bundle size

## [1.0.4] - 2026-04-02

### Fixed

- **backend:** Use certifi CA bundle for urllib SSL verification — resolves `SSL: CERTIFICATE_VERIFY_FAILED` on macOS
- **ci:** Fix manifest signatures and download URLs in release workflow

### Added

- **backend:** Prompt caching — split system prompt into cached/dynamic parts for Anthropic prompt caching (reduces cost on repeated turns)
- **backend:** Zero-LLM-cost context collapse (Layer 3) — drops oldest 1/3 of messages before falling back to full compaction
- **backend:** Streaming tool concurrency — execute concurrent-safe tools (read, glob, grep, search) in parallel during LLM streaming
- **backend:** Microcompact context compression — replace old tool outputs with lightweight stubs, enforce 100K token aggregate budget
- **backend:** Resilient retry with reactive compaction — auto-compact on context overflow, 529 overload handling, exponential backoff with jitter
- **backend:** Web search guardrails — cap native web searches per step and per-search sources to control token usage

### Changed

- **ci:** Update CI workflow and add ESLint configuration for frontend

## [1.0.3] - 2026-03-31

### Fixed

- **ci:** Overhaul macOS CI release workflow for reliable signing and notarization
- **ci:** Overhaul CI release workflow structure
- **ci:** Use `macos-latest` for x64 build (macos-13 deprecated)
- **ci:** Add Node.js download step and fix Windows JSON quoting in CI
- **ci:** Use bash shell for Windows Tauri build step
- **desktop:** Show visible error message when auto-update fails
- **desktop:** Add Applications shortcut to macOS DMG installer

### Changed

- **refactor:** Code quality overhaul — dead code removal, dependency injection unification, configurable limits, usage tracking
- **refactor:** Decompose monolithic components and improve type safety

### Added

- **frontend:** Overhaul mobile remote UX — streaming responses, interactive elements, workspace access

## [1.0.2] - 2026-03-30

### Fixed

- **backend:** Fix cloudflared .tgz extraction on macOS — properly extract binary from archive instead of saving tarball directly
- **frontend:** Auto-approve permission requests in "Edit automatically" mode so file edits and bash commands don't prompt the user
- **frontend:** Fix files panel markdown opening blank by using file-preview type with FilePreviewRenderer
- **frontend:** Fix duplicate artifacts when clicking files created by artifact tool (match on title as fallback)
- **frontend:** Fix memory block disappearing on session switch (move activeWorkspacePath sync into reset effect)
- **frontend:** Fix memory block not auto-refreshing after background queue update (add delayed query invalidation after SSE DONE event)
- **backend:** Fix PyInstaller build to use venv pyinstaller (ensures Python 3.12); add collect_all for uvicorn, wcmatch, croniter

### Added

- **backend/frontend:** Local LLM with custom base URL support — backend config endpoint, frontend settings UI, auto-detect improvements
- **frontend:** Markdown prose polish with serif typography enhancements
- **backend:** Tone guardrails for consistent AI output; improved file path detection in formatting

### Changed

- Remove global memory system and related components (refactor)
- Add multi-platform build configurations (macos-aarch64, macos-x64, windows)
- Update backend requirements (wcmatch 10.0)

## [1.0.1] - 2026-03-20

### Fixed

- **frontend:** Prevent duplicate messages on rapid double-click send ([P0-01])
- **frontend:** Preserve unsent draft text and attachments across session switches ([P0-02])
- **frontend:** Abort backend generation when switching sessions ([P0-03])
- **frontend:** Reset SSE module-level state when navigating away during generation ([P0-04])
- **frontend/backend:** Abort generation before deleting active session; publish DONE event on IntegrityError ([P0-05])
- **backend:** Persist tool error status to database on RejectedError and generic Exception ([P0-06])
- **backend:** Isolate MCP connector failures so one bad connector doesn't block app startup ([P0-07])
- **frontend:** Redirect to provider setup page after skipping onboarding ([P0-08])

### Added

- GitHub Issue templates (Bug Report, Feature Request)
- Pull Request template
- Label definitions for GitHub Issues
- Contributing guide with Conventional Commits convention
- Changelog
