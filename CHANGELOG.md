# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

## [1.1.4] - 2026-04-24

### Fixed

- **desktop:** Restored backend reachability after the v1.1.3 hardening pass. A Content Security Policy regression in v1.1.3 blocked the Tauri `ipc://localhost` channel on all platforms; adding `ipc:` to the `connect-src` allowlist re-enables backend and updater calls from the webview.
- **desktop (auth):** CORS preflight (`OPTIONS`) requests no longer 401. Browsers intentionally strip credentials from preflights, so the auth middleware now forwards them straight to `CORSMiddleware`. Cross-origin API calls from the desktop webview work again.
- **frontend (streaming):** Multi-step assistant turns no longer render duplicate blocks. `streamingParts` accumulates the entire turn, so slicing the group into a "persisted" block plus a separate `StreamingMessage` double-rendered earlier steps (two `Sources` footers, overlapping tool-call timeline).
- **frontend (streaming):** No more full-block fade-in flash when a new session navigates from `/c/new` → `/c/{id}` mid-stream. `StreamingMessage` records whether it mounted with empty content and suppresses the 0.3s opacity animation on a continuation remount.

### Added

- **frontend (skills store):** New "Browse skills" section in Settings → Plugins → Skills. Searches a bundled catalog of ~1.9k curated skills (scraped from skillsmp.com) and installs them in one click. Content is fetched live from GitHub raw on install, so the installed SKILL.md is always current; the catalog itself is refreshed per release and ships with zero runtime dependency on third-party APIs.
- **backend (skills):** `GET /api/skills/store/search` serves the bundled catalog with substring search and stars/recent sorting. `POST /api/skills/install` converts a GitHub URL to `raw.githubusercontent.com`, downloads `SKILL.md`, writes to `~/.openyak/skills/<slug>/`, and rescans the registry so the new skill is immediately usable.
- **backend (scripts):** `scripts/update_skills_catalog.py` — release-time scrape that paginates the upstream search with broad queries, dedupes, and regenerates `backend/app/data/skills_catalog.json`.

### Changed

- **desktop (window):** Default size is now 1360×840 (golden ratio) and every cold start re-centers on screen. The `tauri-plugin-window-state` plugin no longer persists size/position — same-process tray hide/show still keeps the user's arrangement untouched, but quit → relaunch returns to the predictable default. Previously the plugin was restoring saved pixel sizes from earlier versions that no longer made sense (some users saw near-square ratios).
- **providers (openai subscription):** Subscription model list trimmed to GPT-5.5 and GPT-5.4. `header-model-dropdown` now prefers `gpt-5.5` and falls back to `gpt-5.4` if the user's subscription tier hasn't rolled it out yet. Removed: GPT-5.3 Codex, GPT-5.2, GPT-5.2 Code, GPT-5.1 Codex / Codex Max / Codex Mini.
- **frontend (arena scores):** Refresh for the April Intelligence Index — GPT-5.5 bumped from 0 to 60.2; added Claude Opus 4.7 (57.3), Kimi K2.6 (53.9), MiMo V2.5 Pro (53.8), GPT-5.2 (51.3).
- **frontend (workspace pill):** One-step folder picker. Click the pill to open the native picker directly (or the remote-mode browser); inline × clears the workspace. The intermediate popover with its "Browse" and "Clear" buttons is gone.
- **frontend (menu density):** `ContextMenu` and `DropdownMenu` items tightened — 13px text / 6px vertical padding / 14px icons / 10px gap / 6px radius. The old 14px / 8px density felt oversized next to modern desktop conventions (VSCode / Linear / Raycast).

## [1.1.3] - 2026-04-24

### Changed

- **backend (security):** Hardening pass for the local HTTP API — tightened request authentication, origin validation, and CORS scope around the loopback-bound server. No functional change for typical desktop usage; details will be expanded in a follow-up note once the upgrade window has passed.

## [1.1.2] - 2026-04-22

### Added

- **frontend (artifacts):** PDF / DOCX / PPTX / XLSX renderers now pass the active workspace with every `CONTENT_BINARY` request so files resolve in the correct session context. The PDF renderer also supplies `cMapUrl` and `standardFontDataUrl` so CJK and standard fonts render correctly, and memoizes the `file` prop so resize doesn't re-fetch.
- **frontend (build):** `postinstall` and `build` scripts copy pdfjs `cmaps/` and `standard_fonts/` into `public/`; `.gitignore` excludes the copied outputs.
- **frontend (theming):** New `--sidebar-translucent-bg` token (88% alpha light / 20% alpha dark) consumed by `Sidebar` and `SettingsSidebar`, replacing the ad-hoc `/20` alpha. `appearance-injector` derives the token from the user's chosen background.

### Changed

- **frontend (panels):** `workspace-store.open/toggle` now closes Activity / Artifact / PlanReview panels, so side panels are mutually exclusive. The chat header toggles the Workspace panel based on *actually visible* state rather than raw `isOpen`, since overlay panels can cover it.
- **frontend (sidebar motion):** Collapse/expand switched from tween to spring to match the side-panel animations.
- **frontend (layout):** The main layout renders an opaque `surface-chat` backdrop behind the sidebar column so panel transitions no longer flash.
- **frontend (chat polish):** Send button in `chat-actions` uses explicit color tokens so the disabled state stays legible in dark mode; the `context-indicator` tooltip is `pointer-events-none` so it never traps the cursor; "Create new" in automations now uses the outline button style.
- **frontend (activity panel):** Dropped the left border and the vertical timeline connector line for a cleaner look.
- **docs:** Security contact email updated.

### Fixed

- **frontend (activity summary):** Clicking "Done · N tool calls" was a silent no-op — `ActivitySummary.onClick` was gated on `data.sourceKey`, but `MessageContent` built `activityData` without one. `activityKey` is now threaded through `MessageContent` into `sourceKey`, and the chevron rotates when that message's activity panel is open.

## [1.1.1] - 2026-04-22

### Added

- **frontend (appearance):** New Settings → Appearance → **Customize** panel (`appearance-customize.tsx`, `appearance-store.ts`, `appearance-injector.tsx`). Independent light/dark overrides for accent, background, and foreground; UI font family + size; code font family + size (flows through chat messages and diffs); and a pointer-cursor toggle for interactive elements. Every control has an inline Reset to defaults.
- **desktop (tray):** Codex-style tray menu with a dynamic **Recent chats** submenu, pushed from the frontend via the new `update_tray_recents` Tauri command and kept in sync by `use-tray-sync.ts`. Selecting a recent jumps straight into the chat. macOS now ships a proper template tray icon (`tray-template.png` / `@2x`) so the bar icon renders correctly in both dark and light menu bars.
- **frontend (sidebar):** Drag-to-resize sidebar edge (`sidebar-resize-handle.tsx`) with width persisted via `sidebar-store`.
- **frontend (settings):** Dedicated `SettingsSidebar` that swaps in for the main sidebar on `/settings`, driven by a shared `settings-tabs.ts` registry. Tighter `max-w-3xl` content column with a `lg:py-10` spacing bump.
- **frontend (desktop chrome):** New `window-top-icons.tsx` (floating panel-toggle + new-chat) and `use-platform.ts` for platform-aware window chrome.
- **frontend (chat):** Workspace-aware landing greeting — "What should we do in {{workspace}}?" when a workspace is set, else the existing generic greeting. New `greetingInWorkspace` + `expandAll` i18n keys in EN/ZH.
- **desktop (icons):** `build_macos_icons.py` helper plus a regenerated `icon.icns` sourced from a fresh 1024px macOS icon.

### Changed

- **frontend (update-check):** `use-update-check.ts` rewritten end-to-end — clearer states for idle / checking / downloading / ready / error, less flicker across transitions, and explicit handling for the Tauri updater's intermediate events.
- **frontend (sidebar):** Refreshed `sidebar-header`, `sidebar-footer`, `sidebar-nav`, and `projects-toolbar` for a flatter, more consistent look; removed residual right + footer borders on the settings view for a seamless edge.
- **frontend (chat):** Polished `chat-header`, `chat-actions`, `chat-form`, and `landing` layouts; refined `text-part` file-path rendering; button variant polish across the app.
- **frontend (settings layout):** `settings-layout.tsx` lifted its tab registry into `settings-tabs.ts` so the page body and the new `SettingsSidebar` share a single source of truth.
- **desktop (title bar):** Streamlined `title-bar.tsx` now defers to `WindowTopIcons` for the sidebar + new-chat affordances.

### Fixed

- **frontend (static export):** Wrapping `SettingsSidebar` in a `<Suspense>` boundary in `(main)/layout.tsx` so `useSearchParams()` no longer breaks static prerender of `/settings` (regression introduced when the sidebar lifted out of the page component).
- **backend (tests):** `test_e2e.py::TestDoomLoopDetection` dropped the stale `DOOM_LOOP_THRESHOLD` import (removed in the loop-detection refactor) and now exercises the two-stage `LoopDetector` (allow → warn → block).
- **backend (tests):** `test_bash.py::test_unicode_output` uses `python3` instead of bare `python` so the unicode smoke test doesn't require a `python` symlink on the host.

## [1.1.0] - 2026-04-21

### Added

- **backend (channels):** New in-process `app/channels/` subsystem replaces the external Node.js OpenClaw gateway — async `MessageBus`, `BaseChannel` abstraction, `ChannelManager` router, plugin auto-discovery, and an `AgentAdapter` that bridges inbound messages straight into `run_generation()`. All 13 nanobot channels run natively inside the OpenYak process: Telegram, Discord, Slack, WhatsApp (with bundled Baileys Node bridge for QR login), WeChat, Feishu, DingTalk, WeCom, QQ, Email, Matrix, MoChat, WebSocket.
- **backend (compaction):** Manual context compaction — `POST /chat/compact` and `POST /sessions/{id}/compact` with shared SSE/abort lifecycle, gated at ≥50% context usage. `compaction.py` returns a typed `CompactionResult`, supports a `visible_summary` mode (assistant-role with `summary: true`), and honors `job.abort_event` between phases.
- **backend (context window):** `compute_effective_context_window` / `get_effective_context_window` — 33% safe operating ratio with per-model metadata override. GPT-5.4 declares a 258k effective window; `openyak-proxy` is treated as an aggregator with priority dedupe and populates effective windows on `ModelInfo.metadata`.
- **backend (sessions):** `get_session_files` now reads tracked `SessionFile` rows first, with legacy fallbacks that scan `openyak_written/` and run a conservative path-recovery heuristic over old assistant text and tool output. `code_execute` snapshots the workspace before/after to expose `written_files` and tracks them as `SessionFile` rows.
- **backend (streaming):** `streaming/manager.py` emits an explicit `DESYNC` event on SSE replay-buffer overflow instead of crashing on `QueueFull`; `chat.py` honors the `Last-Event-ID` HTTP header for native `EventSource` reconnect.
- **backend (tests):** `test_processor_finish_reason.py` (step finish-reason normalization contract) and `test_utils.py` (large-context retention, partial-message trimming).
- **frontend (sidebar redesign):** New `projects-toolbar.tsx` (collapse-all, add-project file picker, organize/sort popover), `search-command-dialog.tsx` (⌘/Ctrl+K palette with recents, FTS results, ⌘+1..5 jump), grouped Pinned → Projects → Chats virtualizer, slimmer session rows with relative timestamps that fade to a kebab on hover.
- **frontend (sse & chat lifecycle):** DB-recovery finalization via `/chat/active` polling + direct messages refetch; debounced terminal step-finish (1.2s + 8s safety net, replacing the old 30s timeout); `DESYNC` no longer wipes streaming state; `COMPACTED` toast.
- **frontend (chat ui):** `context-indicator.tsx` is now a clickable progress ring that triggers manual compaction with a rich tooltip. Assistant messages separate compaction parts from main content and rename streaming stages (Thinking / Working with tools / Finalizing). `text-part.tsx` upgrades file-path code spans to cards with filename + directory hint and resolves relative paths via the backend. `pptx-renderer.tsx` rewritten to use the new `SlideRenderer` API with a current-slide canvas + thumbnail strip.
- **frontend (i18n):** New en/zh strings for projects/sort/organize, search palette, manual-compaction phases, context-window tooltip, streaming stage labels, recommended-actions heading, plural task counts, and access/action-mode rebrand.
- **desktop (tauri):** Default window bumped to 1200×800 with `minWidth` 1024 so the `lg:block` sidebar is always visible on launch. Setup-phase size clamp in `lib.rs` overrides smaller dimensions restored by the window-state plugin from previous versions.

### Changed

- **backend (provider):** `provider/registry.py` treats `openyak-proxy` as an aggregator with priority deduping. `provider/openrouter.py` only injects the `openyak/best-free` virtual model on the proxy instance (renamed "Yak Free"). Build prompt rebranded "Muse" → "Yakyak/OpenYak" with an added `<skill_routing>` directive.
- **backend (processor):** Step finish reasons normalized (`tool_calls` → `tool_use`, `"empty"` → non-terminal `tool_use`) and validated against the `StepFinishReason` literal. `step-finish` parts are emitted on stream errors; tool_use is forced when tool calls were issued.
- **backend (session/manager):** Skips messages before the latest compaction summary when feeding history back to the LLM.
- **backend (sanitizer):** `sanitize_llm_messages_for_request` no longer silently drops older turns when the budget overflows after partial-trim. Remaining messages keep their envelope (role, `tool_calls`, `tool_call_id`) and large string content collapses to a short `[<kind> truncated for context: …]` marker, preserving conversation shape for LLMs that require paired tool_call / tool_result messages.
- **frontend (landing):** Simplified — removed random capability/starter shuffle and feature hints; honors `?directory=` for "Add new project"; surfaces two recommended actions.
- **frontend (palette):** `globals.css` rebrand from "Pure Black & White" to a Codex-aligned palette (blue accent `#339CFF`, refined surfaces/borders, dark theme tokens).
- **frontend (workspace):** Workspace section cards (progress, files, context) restyled with translucent rounded cards, badges, and previews. Defaults all sections collapsed but auto-opens the panel when todos/files arrive; collapses progress once all todos are completed.
- **frontend (settings):** `providers-tab.tsx` wires provider activation to auto-select a matching model; removes the legacy single-key BYOK input.
- **frontend (sidebar footer/nav):** Collapsed to a single Settings link (provider/balance UI removed); sidebar nav reduced to a search button that opens the palette.

### Removed

- **backend:** The entire `app/openclaw/` directory and every `openclaw_*` config setting. Channels are now built-in — no external gateway to install or manage.
- **frontend:** OpenClaw gateway install/start/stop UI, hooks, types, and constants. Mobile settings switched from the deprecated hook to `useChannelStatus()`.

### Fixed

- **frontend (sidebar borders):** Removed right + footer borders for a seamless edge against the main content column.
- **frontend (ci):** `npx tsc --noEmit` is now expected to pass locally before pushing. Three type errors slipped through on HEAD (`page.tsx` passing a stale `sessionId` prop, `message-list.tsx` direct cast to `Record<string, unknown>`, missing `summary_created` on `SSEEventData`) — all cleared.

## [1.0.8] - 2026-04-12

### Fixed

- **desktop (remote access):** Mobile PWA at `/m?token=…` was returning 404 over the Cloudflare tunnel on every 1.0.7 install, making QR-code / link-based phone pairing unusable. Root cause: the PyInstaller spec silently dropped missing data paths, so the Next.js static export (`frontend/out`) never made it into the bundled backend and the FastAPI `/m` route was therefore never registered. The desktop UI kept working because Tauri reads the frontend from its own app resources, which hid the break entirely from local testing. The spec now treats every data entry as required and aborts the build if any are missing.
- **desktop (auto-updater):** Auto-update failed with `signature verification failed` for users trying to move off 1.0.6/1.0.7 on macOS. Root cause: the updater manifest pointed at an unversioned `OpenYak.app.tar.gz`, so uploading a new release overwrote the previous tarball while the old `latest.json` signature was still live — producing a byte/signature mismatch for anyone mid-upgrade. macOS updater artifacts are now published as `OpenYak_${VERSION}_${ARCH}.app.tar.gz` and each release has its own immutable, signature-bound download.

### Added

- **ci:** `scripts/verify-bundle.mjs` — post-PyInstaller gate shared by local dev and CI. Performs static checks on 16 required assets (backend binary, Alembic, agent prompts, bundled skills/plugins, `frontend_out/m.html` + `_next/static`, and extracted Python packages) and then runs a real runtime smoke test: launches the bundled binary on a throwaway port, fetches `/m`, and requires HTTP 200 with HTML. This is the exact failure mode from 1.0.7 turned into a hard build-time gate so it cannot silently regress again. Cross-compiled artifacts can skip the smoke step with `VERIFY_BUNDLE_SKIP_SMOKE=1`.
- **ci:** `verify-bundle` is wired into all three release jobs (Windows, macOS aarch64/x64, Linux) and runs a second time on macOS against the signed `.app` bundle to catch Tauri resource-path drift.

### Changed

- **ci (publish):** Update-manifest generation now fails loudly if any platform's signature or artifact filename is empty — instead of writing an empty field and breaking every client's auto-update — and validates the generated `latest.json` as well-formed JSON before upload.

## [1.0.7] - 2026-04-12

### Fixed

- **desktop (Windows):** Installer no longer fails with `Error opening file for writing: ...\backend\_internal\*.pyd` when upgrading. Added a NSIS `NSIS_HOOK_PREINSTALL` hook that terminates the `openyak-backend.exe` sidecar (and any leftover `OpenYak.exe`) before file extraction, releasing locks on PyInstaller-bundled `.pyd` files (PIL `_imaging`, mypyc-compiled modules, etc.) so they can be overwritten cleanly. Fixes [#11](https://github.com/openyak/openyak/issues/11).

### Changed

- **desktop (Windows):** Reverted NSIS `installMode` back to the default (`currentUser`). The previous `"both"` setting added an unnecessary install-scope prompt and risked relocating users from `%LocalAppData%\OpenYak` to `C:\Program Files\OpenYak`, which would have broken auto-update continuity for existing 1.0.6 installs.

### Updated

- **frontend:** Refreshed model Intelligence Index scores and popularity rankings from OpenRouter (April 2026 data), adding new entries for MiMo V2 Pro, Qwen3.6 Plus, MiniMax M2.7, GLM 5 Turbo, Nemotron 3 Super, Hunter Alpha, and others

## [1.0.6] - 2026-04-09

### Added

- **backend:** ToolSearch meta-tool — agents can now discover and load deferred MCP tool schemas on demand via keyword or exact-name search, enabling dynamic tool expansion without bloating initial context
- **frontend:** Three-dot dropdown menu on session sidebar items — quick access to rename, pin/unpin, export (PDF/Markdown), and delete without right-clicking
- **frontend:** `extractApiDetail` helper for provider error display — properly surfaces FastAPI 422 validation errors instead of generic fallback messages

### Fixed

- **backend:** Env file value quoting — values containing `#` (e.g., JSON with URL fragments) are now single-quoted to prevent dotenv comment truncation
- **frontend:** Chat header z-index — added `relative z-10` to prevent content overlapping the header during scroll

### Changed

- **backend:** Simplified agent build prompt — removed verbose inline tool listings and redundant "when to use todo" instructions; added rule for auto-analyzing attached data files
- **backend:** Refactored session prompt building, system prompt construction, and connector/tool registry initialization for cleaner separation of concerns
- **desktop:** Updated all Tauri app icons across Windows, macOS, iOS, and Android targets
- **scripts:** Dev script now uses `python` instead of `./venv/bin/python` for cross-platform compatibility
- **license:** Changed from AGPLv3 to MIT

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
