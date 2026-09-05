# README product screenshots

The four `*-dark.png` images are unmodified screenshots of the real OpenYak v2
Electron GUI at 1440 × 960 CSS pixels, captured on macOS in dark mode. They are not
AI-generated interfaces. All project data is fictional and isolated from personal
OpenYak data in a fresh temporary `OPENYAK_DATA_DIR`.

| File | What it demonstrates |
| --- | --- |
| `workbench-dark.png` | Real Codex-generated Markdown report beside the chat |
| `artifacts-dark.png` | Hand-authored HTML fixture rendered in the sandboxed file preview; persistent tabs |
| `providers-dark.png` | Actual runtime/model selector; availability varies by account |
| `browser-dark.png` | Codex operating the local demo page through the shared browser, then user takeover |

Reproduce from the repository root after `npm install` and `npm run build`:

```bash
node app/scripts/readme-screenshots.mjs
```

Requires local Codex authentication and Google Chrome. This is an opt-in live-agent
run that can consume provider usage. The script verifies its isolated data directory,
uses the real Dark appearance setting, serves the demo page on loopback, and only
accepts narrowly scoped demo operations. It does not copy credentials or personal
chats, alter screenshot pixels, or fabricate product DOM. Agent output may vary.

Fixtures live in `app/test/fixtures/readme/`: `brief.md` supplies fictional metrics,
and `dashboard.html` is hand-authored. The report is generated during the run.
These images demonstrate the Codex path, not complete Claude or desktop-control
acceptance. Inspect new captures before committing them.

Brand assets are separate: see the [brandkit](../../brandkit/README.md) for the
current Logo, Banner, style guide, tokens and generation provenance. The previous
`docs/images/banner-v2.png` path is now `brandkit/banners/readme-dark.png`.
