# v2: pivot OpenYak to macOS-only, drop hosted backends, recommend Rapid-MLX as the local runtime

## Context

OpenYak v1 shipped as a cross-platform desktop app (macOS / Windows / Linux) that fanned out across five model-access modes:

1. **OpenYak Account** — managed proxy at `api.open-yak.com` with weekly free quota and paid credits (the SaaS).
2. **BYOK** — direct keys to 21 catalog providers (OpenAI, Anthropic, Google, Groq, DeepSeek, Mistral, xAI, Together, DeepInfra, Cerebras, Cohere, Perplexity, Fireworks, Azure, Qwen, Kimi, MiniMax, Zhipu, SiliconFlow, Xiaomi, OpenRouter).
3. **ChatGPT Subscription** — OAuth login with a ChatGPT Plus/Pro/Team account, OpenAI's Codex token-exchange flow.
4. **Ollama** — bundled binary downloader + lifecycle manager + model library browser.
5. **Local API + Custom Endpoint** — generic OpenAI-compatible base URL.

Each lane added surface area: a settings panel, a registry adapter, telemetry plumbing, an i18n block, error-recovery copy, and at least one issue category. The five-lane fan-out also forced product copy to read like a comparison matrix instead of a recommendation: "free credits OR your own keys OR your subscription OR a local model OR a custom URL." Users who installed OpenYak to *try local models* still had to navigate around four cloud-shaped affordances first.

A handful of harder-to-quantify pressures pushed us to consolidate now rather than later:

- **Operational cost of `api.open-yak.com`.** The hosted proxy required token refresh plumbing, abuse-rate guards, weekly quota accounting, an OAuth flow, and an EC2 deploy pipeline. Per `feedback_proxy_deploy_full_app_sync.md` we had a 25-day prod incident from piecemeal scp; per the launch-history memos the SaaS framing ("we hold your tokens") was the consistent sore point at HN + Product Hunt feedback rounds.
- **macOS is where the local-model story actually wins.** Apple Silicon has unified memory; MLX-based runtimes (Rapid-MLX in particular) get throughput on a MacBook that Windows + Linux equivalents need a discrete GPU to match. Bundling Ollama on Linux laptops without a GPU was, in practice, false advertising.
- **Maintenance honesty.** A two-person team cannot keep 21 BYOK adapters, three OAuth flows, an Ollama lifecycle manager, *and* three platform installers continuously green. v1 spent more PRs on "fix provider X catalog drift" than on the local-model UX we want to be known for.

## Decision

Cut OpenYak v2 as a **macOS-only, local-first desktop app** with exactly two model-access modes:

1. **Rapid-MLX (Local)** — the rebrand of the existing `local` provider, oriented around the user installing the [Rapid-MLX](https://github.com/raullenchai/Rapid-MLX) CLI (`brew install raullenchai/rapid-mlx/rapid-mlx` or `pip install rapid-mlx`) and pointing OpenYak at `http://localhost:8000/v1`.
2. **Custom Endpoint** — generic OpenAI-compatible base URL for power users who want to point at any other inference server (vLLM, llama.cpp server, a self-hosted gateway, a colleague's MLX rig, etc.).

Everything else is removed:

- OpenYak Account / `api.open-yak.com` proxy mode → cut (PR 1, [#79](https://github.com/openyak/openyak/pull/79)). SaaS server scheduled for shutdown 30 days after v2.0.0 release.
- ChatGPT Subscription → cut (PR 2, [#77](https://github.com/openyak/openyak/pull/77)).
- BYOK + 21-provider catalog → cut (PR 3, [#78](https://github.com/openyak/openyak/pull/78)). `OpenRouterProvider` class is retained as a test fixture only.
- Ollama → cut (PR 4, [#76](https://github.com/openyak/openyak/pull/76)). Users who want Ollama can still point Custom Endpoint at `http://localhost:11434/v1`; we just no longer manage the binary.
- Windows + Linux builds → cut (PR 6, [#75](https://github.com/openyak/openyak/pull/75)).

Rapid-MLX is **not bundled** as a Tauri sidecar in the v2.0.0 cut. PR 5 ([#80](https://github.com/openyak/openyak/pull/80)) only adds `GET /api/config/rapid-mlx/status` (probes `which rapid-mlx`) and a "please install Rapid-MLX" hint in the settings panel. Sidecar bundling is deferred — see "Considered options" below.

## Consequences

**What gets simpler.** The provider registry collapses to two modes and the settings page collapses to one card. Three OAuth flows (OpenYak email/code, ChatGPT Codex, Google login for the proxy) are gone. The 21-provider catalog with its per-provider key validation, masking, masked-display, error copy, and i18n keys is gone. Ollama's binary downloader, port allocator, lifecycle manager, model library browser, and update flow are gone. macOS-only means we drop a Tauri Windows installer + a Linux AppImage matrix from CI plus all per-platform branches in the codebase.

**What gets harder.** A user who pulls v2.0.0 onto a Mac with no Rapid-MLX installed sees an "install this" hint instead of a working chat box. We accept that step in exchange for not pretending the local-model UX works without a local model server. The Custom Endpoint mode is the escape hatch for users who want a different runtime.

**SaaS shutdown.** `api.open-yak.com` gets a 30-day EOL announcement at release time and is taken down on day 30. v1 users who depended on the free weekly quota or paid credits will be migrated to direct billing instructions for the underlying providers (mailing list captured in `reference_release_email.md`). v1 binaries continue to function until the SaaS endpoint goes away.

**Cross-platform users.** v1 binaries for Windows + Linux remain downloadable from the [v1.x releases page](https://github.com/openyak/openyak/releases) but stop receiving updates. CHANGELOG and the v2.0.0 release notes will call this out explicitly so users can pin v1.x if they need cross-platform support.

**ECS deploy footprint.** Per `feedback_ecs_release_deploy.md` and `reference_release_packaging.md`, the open-yak.com ECS service still needs the standard "replace all platform artifacts + verify before/after" treatment for the v2.0.0 cut, and the latest.json file is still uploaded last so cross-region downloads see consistent state. After the SaaS shutdown the ECS service downsizes to artifact serving only (no proxy backend).

## Considered options

**Bundle Rapid-MLX as a Tauri sidecar via PyInstaller.** Tempting because it would make `dmg → first launch → working chat` the golden path with no install step. Rejected for v2.0.0 because: Rapid-MLX is a Python package (~200MB once you pull in `mlx`, `mlx_lm`, transformers tokenizers, etc.) and PyInstaller bundling pushes our DMG from ~80MB to ~500MB+. Ship-quality codesigning + notarization on a 500MB DMG with embedded Python is a non-trivial second engineering project. The user-installed CLI path works today and lets the user upgrade Rapid-MLX independently of OpenYak releases. We can revisit sidecar bundling in v2.x once the user-install path has produced data on how often that step actually trips users.

**Bundle Rapid-MLX runtime *and* spawn `rapid-mlx serve` from the backend.** Rejected for the same DMG-size reason, plus the lifecycle complexity (port allocation, model-download progress, OOM handling, restart on crash) is a meaningful chunk of work that the existing Custom Endpoint pattern already lets users solve for themselves with `rapid-mlx serve <model>` in a terminal.

**Keep BYOK as a "pro" mode behind an advanced toggle.** Rejected: the maintenance cost of catalog drift is the same whether the entry point is hidden or surfaced. If we want a hosted-key story back later, we can add it back as a single OpenRouter-backed mode (one provider, one catalog, no fan-out) rather than restoring all 21.

**Cross-platform v2 with macOS-only Rapid-MLX recommendation.** Rejected: the value of the macOS pivot is not just the recommended runtime — it's also the freed CI matrix, the dropped Windows-specific code paths (cloudflared subprocess differences, NSVisualEffectView vs none, codesign vs Authenticode), and the honesty of saying out loud that Apple Silicon is where local models work best in 2026. Cross-platform v2 would have kept all of that complexity for a story that, on Windows + Linux without a discrete GPU, doesn't actually deliver.

**Skip the SaaS shutdown announcement and just turn off `api.open-yak.com`.** Rejected: existing users have credit balances and weekly quotas they were promised. 30 days plus an in-app announcement plus an email blast (per `reference_release_email.md`) is the minimum honest treatment. The shutdown date and migration instructions are part of the v2.0.0 release notes, not a follow-up.
