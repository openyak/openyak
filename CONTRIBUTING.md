# Contributing to OpenYak

Thanks for helping. OpenYak v2 is early; the fastest way to help is to use it on a real
task with Claude Code and Codex and file what breaks.

## Setup

Prerequisites: Node 26, Rust 1.90 (`mise install` handles both), and an existing
Claude Code or Codex sign-in. Agent dependencies are pinned in the app; compatible
local binaries can be selected with the environment overrides documented in
`docs/native-agent-runtime.md`. The shared browser also requires Google Chrome.

```bash
npm install
npm run dev          # builds core, starts Electron with hot reload
```

```bash
npm run check        # core tests + app tests + TypeScript + ESLint
npm run build        # production core and Electron build
```

## Scope

v2 owns the GUI, persistent conversation, and host integrations. Agent reasoning
and execution belong to provider runtimes: native Codex App Server and Claude Agent
SDK by default, with ACP as an opt-in compatibility path. Read
`docs/native-agent-runtime.md` and `docs/shared-browser.md` before proposing changes
to runtime or browser behavior. Do not claim parity with private Desktop features.

## GUI verification

Use fresh, isolated `OPENYAK_DATA_DIR` directories, never personal conversations or
saved permission grants. Build first, then run the relevant acceptance scripts:

```bash
node app/scripts/desktop-icons-acceptance.mjs
node app/scripts/browser-host-acceptance.mjs
node app/scripts/browser-gui-acceptance.mjs # opt-in: uses a real Codex session
node app/scripts/readme-screenshots.mjs   # opt-in: real Codex, fictional demo data
```

Live-agent scripts use your existing login and may consume provider usage. Inspect
captures for private information before publishing. README product screenshots
must come from the real app; identify fictional fixtures and keep generated brand
art separate. See `docs/images/README.md` for provenance.

The [v2 CI workflow](docs/ci.md) runs deterministic runtime and real desktop/browser
regressions on macOS without model inference or account secrets. Documentation-only
changes skip the expensive checks. `V2 CI` is the stable required-check name; local
checks remain useful before opening a pull request.

## Pull requests

- One change per PR, with the reasoning in the description.
- `npm run check` and `npm run build` must pass.
- Follow the vocabulary in `CONTEXT.md`.

Looking for the v1 codebase? It lives on the `legacy/v1` branch.
