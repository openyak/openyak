# V2 CI: regression signals, not a test-count target

Workflow: [`.github/workflows/v2.yml`](../.github/workflows/v2.yml).

## What blocks a change

| Check | Failure it catches |
| --- | --- |
| Core tests | Transcript persistence, handoff, event preservation, permission routing and file-output normalization |
| App tests + TypeScript + ESLint | Provider contract changes, stream reconciliation, question/approval semantics, tab state and unsafe file references |
| Release Core + Electron build | Missing imports/assets, native-worker bundling and production-only build failures |
| Real Core process + deterministic worker | Restart/resume losing history, concurrent question IDs colliding, cancellation hanging, provider crash not terminating a turn |
| Real Electron file-preview flow | Broken clickable files, Markdown/HTML rendering, code line targets, lost tabs, traversal/symlink escapes and cross-task IPC |
| Real Electron desktop shell | Missing bundled icons, invalid menu-bar resources, window reopen/cleanup failures and app startup failures |
| Real Chrome + browser host + MCP client | Missing authorization, cross-task browser access, takeover not blocking the agent, input not reaching the shared page, wrong HiDPI pixels and stale frames |

Fixtures replace nondeterministic provider responses, not the Core process,
filesystem, Electron renderer or browser. The browser test uses a loopback page
and a direct MCP client: it proves host behavior, not model tool-selection ability.
The file-preview test uses persisted fixture messages and the actual app/core path.

The existing fast tests run as a suite (normally under a second for the App). Do
not add coverage-percentage gates, source-text assertions, class-name snapshots,
or duplicate platform jobs merely to increase the count. Add a regression test
when it protects a concrete contract or reproduces a real failure.

## Triggers and cost

- Pull requests targeting `main`, pushes to `main`, and manual dispatch.
- A small Linux scope job selects checks. Changes under `app/`, `core/`, the CI
  workflow/scripts, Cargo configuration, or root dependency/toolchain inputs run
  verification. README, screenshots, other docs and legacy v1-only changes skip it.
- One macOS 15 verification job: this is the desktop platform currently exercised
  by the project. No Linux/Windows desktop-support claim is implied.
- `mise.toml` is the single source for Node and Rust versions. `npm ci` and Cargo
  `--locked` use the committed dependencies. Build once, then run smoke tests against
  that release Core via `OPENYAK_CORE_BIN`; do not build a second debug binary.
- Cache npm downloads and Rust compilation, cancel superseded runs, bound every
  integration step, retain only failed-run GUI screenshots for seven days.

Set **`V2 CI`** as the required branch-protection check. The final job runs even
when earlier jobs fail or skip: docs-only changes succeed explicitly, while scope
failure, test failure, or cancellation cannot masquerade as a successful skip.
The workflow does not use a top-level `paths` filter because that can leave required
checks pending. See [GitHub's required-check guidance](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

This change does not itself modify repository branch-protection settings.

## Deliberately outside required CI

- Real Codex/Claude inference, login, quota and provider availability: opt-in live
  acceptance only; no API keys, personal sessions or paid calls in required checks.
- README screenshot generation and exact pixel/font comparisons: visual review,
  not a merge gate dependent on model wording or runner font rendering.
- External websites, native desktop accessibility/control, and complete private
  Desktop feature parity: not established by these checks.
- PDF/DOCX end-to-end rendering and full multi-agent workflows are not covered by
  the current Electron smoke flow; helper/contract tests are not a substitute.
- Installer signing, release publishing, v1 Tauri builds, arbitrary coverage
  thresholds, and network-based dependency-audit gates are not part of this workflow.

Actions are pinned to commit SHAs, checkout credentials are not persisted, and
the workflow uses only read permission. No `pull_request_target`, secrets, personal
OpenYak data, browser profiles or databases are uploaded. Fork PRs use hosted runners.

## Local reproduction (macOS)

```bash
mise install
npm ci
cargo test --locked --manifest-path core/Cargo.toml
npm run test -w app
npm run check -w app
cargo build --locked --release --manifest-path core/Cargo.toml
npm run build -w app
export OPENYAK_CORE_BIN="$PWD/core/target/release/openyak-core"
node app/scripts/native-core-smoke.mjs fake
node app/scripts/file-preview-gui-smoke.mjs
node app/scripts/desktop-icons-acceptance.mjs
node app/scripts/browser-host-acceptance.mjs
```

Chrome is provided by the [macOS hosted runner image](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md);
install it locally for the browser check. The test creates an isolated headless
session, not a user's regular Chrome profile. If a hosted image/toolchain changes,
report it as an infrastructure failure rather than silently skipping a check.
