# Shared browser workbench

OpenYak v2 now exposes a task-owned browser through the public Playwright MCP
server and displays that exact browser's live Chromium surface in the right
workbench. This is an interactive remote surface, **not** an Electron
`WebContentsView`, a duplicate website iframe, or a stream of transcript images.

Display frames use lossless PNG compositor captures at the panel's display
density (1–3x), not the 1x JPEG returned by Chromium screencast. Screencast is
used only as a paint notification source. Captures are single-flight with one
coalesced pending refresh; stale results after resize/tab switch are discarded.
Canvas backing pixels follow the encoded image, while pointer coordinates stay
in CSS pixels. Display-density changes between monitors refresh the capture.
This improves text fidelity but does not promise native compositor latency or
60-fps video performance.

## Provider integration

- Codex App Server receives a session-scoped `mcp_servers.openyak_browser`
  override at thread start/resume.
- Claude Agent SDK receives an HTTP `mcpServers.openyak_browser` entry.
- No global Codex/Claude config, private Desktop system prompt, user browser
  profile, or tool catalogue is rewritten. MCP schemas/descriptions come from
  `@playwright/mcp` (pinned to 0.0.80 and its matching Playwright dependency).
- The native worker receives Core's task ID, registers with the browser host,
  then passes only the task-specific MCP URL into the provider. The host-wide
  registration secret is removed from subprocess environments.
- Existing external Chrome / `cua_repl` / native desktop automation plugins are
  separate. They are not redirected into this panel. Use `openyak_browser` for
  the shared workbench. ACP-only fallback does not receive this native injection.

Public contracts: [Playwright MCP](https://github.com/microsoft/playwright-mcp),
[Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Codex thread-start schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartParams.ts).

## Interaction and lifecycle

- Genuine browser pages appear alongside file/artifact tabs. Each page keeps its
  own DOM, navigation history and form state when switching tabs.
- Compact tab strip, URL entry, back/forward/reload, new/close tab and hide panel.
- The host captures only the visible page. Switching tasks/files or hiding the
  panel detaches its capture session. Browser frames are not persisted to chats.
- Mouse/keyboard/wheel input is sent to the same Playwright page. The user must
  take control first. New browser tabs opened by the user also take control.
- Takeover rejects new and queued MCP calls; an already-running call must finish
  before user input is enabled. Calls are serialized across connected providers.
  A transport timeout closes the isolated browser before releasing the barrier.
- Resume aligns Playwright MCP's selected tab with the visible user tab using
  the public `browser_tabs` contract, then re-enables agent calls. It does not
  automatically send a new model prompt or resume a completed model turn.
- Page dialogs have a host-rendered response UI; agent-side dialog tools remain
  available. Closing a task or quitting closes its browser resources. Browser
  sessions/cookies are intentionally ephemeral and do not survive app restart.

## Requirements and boundaries

Installed Google Chrome is required by default. Administrators may select a
compatible executable with `OPENYAK_BROWSER_EXECUTABLE`. OpenYak never installs
a browser or modifies an existing profile automatically.

The dedicated browser has no Electron preload, Node integration, or access to
the application debug target. Its HTTP MCP endpoint binds loopback, uses a
task-specific unguessable URL, and rejects browser Origin headers / unexpected
Host headers. User-entered navigation permits HTTP(S) only. Chromium's sandbox
remains enabled. Downloads and service workers are disabled in the context.

This isolates web content from the Electron host; it is **not** a sandbox for an
agent that already has local shell/filesystem authority. Normal provider tool
approvals still apply and are not bypassed by the GUI.

This is not full Codex Desktop parity. Native desktop apps, external browser
sessions, browser extension UI, native clipboard integration, file pickers,
screen-reader access to the remote DOM and video/60-fps performance are not
certified by this implementation. The Claude connection is implemented but
has not received the real-model GUI acceptance run described below.

## Verification

Clarity regression (2026-09-04 local): the host test first failed on the old
JPEG transport, then passed with actual PNG dimensions at 1x, 1.5x and 2x,
live input updates and no stale frames after detach. The isolated real Codex
GUI run measured 1132×1568 backing pixels for a 566×784 CSS panel at DPR 2;
pointer input, agent readback, tabs and narrow hide/restore passed, with no
renderer errors. Inspected screenshots and results are in
`../.codex-artifacts/browser-clarity-2026-09-04/`. These checks validate pixel
density and interaction, not native-browser frame-rate parity.

From the repository root:

```sh
npm run check -w app
npm test -w app
cargo test --manifest-path core/Cargo.toml
npm run build -w app
cargo build --release --manifest-path core/Cargo.toml
node app/scripts/browser-host-acceptance.mjs
node app/scripts/browser-gui-acceptance.mjs
```

The last command uses real Codex inference and a fresh `OPENYAK_DATA_DIR` under
the system temporary directory. It never copies normal OpenYak user data. It
approves only the isolated test's named browser calls, one request at a time.

Verified on macOS with installed Chrome:

- App unit tests: 96 passed; Core tests: 56 passed; TypeScript, ESLint and build pass.
- Host integration: official catalogue (30 tools), real navigation/click,
  Chromium frames, user text read back via MCP, takeover rejection, cross-task
  page rejection, HTTP origin/auth rejection, browser close/reopen and endpoint
  revocation after task deletion.
- Real Codex GUI: server-observed button click (`VERIFIED`), visible browser,
  real canvas pointer/keyboard entry (`USER_HANDOFF_73`), agent snapshot reads
  exactly that input after resume, two preserved tabs, narrow hide/restore.
- GUI screenshots are inspected separately from assertions; no fps or latency
  equivalence to Codex is claimed.

Latest real-model evidence (2026-09-04 local time):
`../.codex-artifacts/shared-browser-2026-09-04/results.json`,
`agent-resumed.png`, and `narrow-browser.png` in the same directory. The
isolated test app was closed after verification; the user's regular app/data
were not operated on. Changes are local and have not been committed or pushed.
