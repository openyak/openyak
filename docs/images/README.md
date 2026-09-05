# README visual assets

## Product captures

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

## Banner

`banner-v2.png` is original AI-generated brand artwork, not a product screenshot.
Generated on 2026-09-04 with the built-in `image_gen` tool in generation mode,
without reference images; copied into this repository without modification.

Prompt:

```text
Use case: ads-marketing
Asset type: GitHub README banner for OpenYak v2, very wide 3:1 composition, approximately 1800x600.
Primary request: Design a polished, distinctive dark banner for an open-source desktop workbench for AI agents. This is brand artwork, NOT a screenshot or mock application interface.
Scene/backdrop: near-black charcoal, restrained fine grain and thin flowing paths joining into one continuous path, suggesting multiple agents sharing one conversation. Subtle depth, editorial graphic design, ample negative space. Avoid generic neon AI brains, robot mascots, floating UI cards.
Typography: large, exceptionally clear off-white contemporary sans serif, spelling OpenYak exactly (O p e n Y a k). Subheadline equally crisp. Delicate electric-blue and warm pale-yellow accents reflect the existing product palette. Minimal but memorable.
Text verbatim, only these two lines: "OpenYak" and "One chat. Every agent."
Constraints: no fake product UI, no performance claims, no other company logos, no extra text, no watermark. Place all text well within safe margins. Make it legible as a README header at 900px wide.
```
