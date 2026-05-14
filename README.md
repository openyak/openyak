# OpenYak

<p align="center">
  <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/lang-中文-blue?style=flat-square" alt="中文" /></a>
  <a href="https://github.com/openyak/openyak/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/openyak/openyak/ci.yml?branch=main&style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://github.com/openyak/openyak/stargazers"><img src="https://img.shields.io/github/stars/openyak/openyak?style=flat-square" alt="GitHub Stars" /></a>
  <a href="https://github.com/openyak/openyak/blob/main/LICENSE"><img src="https://img.shields.io/github/license/openyak/openyak?style=flat-square" alt="License" /></a>
  <a href="https://github.com/openyak/openyak/releases/latest"><img src="https://img.shields.io/github/v/release/openyak/openyak?style=flat-square" alt="Latest Release" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square" alt="Platform: macOS | Windows | Linux" />
  <a href="https://github.com/openyak/openyak/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs Welcome" /></a>
</p>

<p align="center">
  <img src="docs/readme/openyak-workflow-artifacts.gif" width="900" alt="OpenYak turns uploaded office files into a structured answer and reusable artifact" />
</p>

<h3 align="center">A local AI workspace for turning files, chats, and messy office context into deliverables.</h3>

<p align="center">
  Read local files, compare spreadsheets, review decks, synthesize PDFs, create artifacts, continue long threads, and keep the work on your machine.
</p>

---

## Why OpenYak

OpenYak is built for real work, not just one-off chat prompts.

- **Work from your actual files.** Upload DOCX, XLSX, PPTX, PDFs, CSVs, and local project context, then ask for briefs, tables, follow-ups, plans, and reusable artifacts.
- **Keep the workflow in one thread.** Start with analysis, continue into a RACI, ask for a follow-up email, and preserve context across long conversations.
- **Choose your model path.** Bring your own API key, connect a ChatGPT subscription, or run local models through [Rapid-MLX](https://github.com/raullenchai/Rapid-MLX) on Apple Silicon or [Ollama](https://ollama.com).
- **Stay local by default.** Files, conversations, memory, and generated artifacts are stored on your device. Cloud model calls go directly to the model provider you choose.
- **Use it from another device.** Remote access lets you scan a QR code and send tasks to your desktop through a secure tunnel.

## What It Feels Like

| Ask OpenYak to... | It should give you... |
|-------------------|------------------------|
| Read a long memo | Executive brief, risks, owners, next actions, and a send-ready email |
| Analyze a workbook | Budget vs. actual variance, drivers, anomalies, and finance talking points |
| Review a deck | Slide-by-slide story, evidence gaps, speaker notes, and decision ask |
| Synthesize several files | One board brief that reconciles memo, budget, deck, and PDF context |
| Continue the same thread | RACI, 30-day plan, agenda, and follow-up drafts without restating context |
| Recover from an error | Clear next step when upload, auth, or file parsing fails |

## Office Workflows

### From Memo to Executive Brief

OpenYak can turn a dense memo into a structured brief that is ready for a manager, team update, or follow-up email.

<p align="center">
  <img src="docs/readme/openyak-memo-to-brief.gif" width="900" alt="OpenYak memo to executive brief workflow" />
</p>

<p align="center">
  <img src="docs/readme/openyak-docx-brief.png" width="900" alt="Close-up of a DOCX memo review result in OpenYak" />
</p>

### From Spreadsheet to Finance View

Use spreadsheets as working inputs, not screenshots. Ask for budget variance, forecast risks, owner-level action items, and meeting-ready talking points.

<p align="center">
  <img src="docs/readme/openyak-budget-analysis.png" width="900" alt="Close-up of a spreadsheet budget analysis result in OpenYak" />
</p>

### From Multiple Files to an Artifact

OpenYak can synthesize several files in the same thread and open a right-side artifact panel for reusable briefs, plans, diagrams, and structured outputs.

<p align="center">
  <img src="docs/readme/openyak-artifact-panel.png" width="900" alt="OpenYak artifact panel with a multi-file board brief" />
</p>

### Long Threads and Auto-Compress

Real office work rarely fits in one message. OpenYak is designed for follow-ups, revisions, and long conversations where the important context needs to remain available.

<p align="center">
  <img src="docs/readme/openyak-auto-compress.gif" width="900" alt="OpenYak long-context auto-compress workflow" />
</p>

<p align="center">
  <img src="docs/readme/openyak-long-context.png" width="900" alt="OpenYak long thread with preserved context" />
</p>

## Download

| Platform | Architecture | Formats |
|----------|--------------|---------|
| macOS | Apple Silicon / Intel | `.dmg`, `.app` |
| Windows | x64 | `.exe` installer |
| Linux | x64 | `.deb`, `.rpm` |

> [Download the latest release](https://github.com/openyak/openyak/releases/latest) or visit [open-yak.com/download](https://open-yak.com/download/).
>
> Linux users can also read [LINUX.md](LINUX.md) for requirements and troubleshooting.

## Get Started

1. **Install OpenYak** for your platform.
2. **Connect a model** using free cloud models, your own API key, ChatGPT subscription, Rapid-MLX, or local Ollama.
3. **Start a new conversation** and attach a real file.
4. **Ask for a deliverable**, not just a summary: brief, action plan, RACI, email, table, or artifact.
5. **Review the result** in the chat and artifact panel, then continue in the same thread.

Example prompt:

```text
Please read the files I uploaded and turn them into a concise team brief.
Start with three key takeaways, then list risks, owners, and next actions.
Finally, write a follow-up email I can send to the team directly.
```

## Supported Providers

### Cloud and Subscription

| Provider | Access | Notes |
|----------|--------|-------|
| OpenRouter | BYOK | Bring your own OpenRouter API key |
| OpenAI | BYOK | Bring your own API key |
| Anthropic | BYOK | Bring your own API key |
| Google | BYOK | Gemini models |
| DeepSeek | BYOK | Direct provider key |
| Groq | BYOK | Fast hosted inference |
| Mistral | BYOK | Direct provider key |
| xAI | BYOK | Grok models |
| Qwen | BYOK | Direct provider key |
| Kimi | BYOK | Moonshot models |
| MiniMax | BYOK | Direct provider key |
| Zhipu | BYOK | Direct provider key |
| ChatGPT | Subscription | Use an existing ChatGPT Plus, Pro, Team, or Enterprise plan when available |

### Local

- **Rapid-MLX:** Apple Silicon macOS users can start and switch curated MLX models from Settings. OpenYak connects to Rapid-MLX's OpenAI-compatible API on `localhost`.
- **Ollama:** Run any model available through [Ollama](https://ollama.com). Local models are auto-detected and can be used without an internet connection.

## Core Capabilities

- **File understanding:** office docs, spreadsheets, slide decks, PDFs, CSVs, local folders, and generated artifacts.
- **Artifact workspace:** reusable Markdown briefs, tables, diagrams, checklists, and structured outputs.
- **Tool execution:** read, write, rename, organize, and automate files with user-controlled permissions.
- **Long-context work:** continue from analysis to planning to follow-up without starting over.
- **Remote access:** connect from mobile through QR code and Cloudflare Tunnel.
- **Automations:** schedule recurring cleanup, reporting, and file workflows.
- **Privacy controls:** local storage, BYOK options, and local model support.

## For Developers

**Tech Stack:** Tauri v2, Rust, Next.js 15, FastAPI, SQLite

**Monorepo Structure:**

```text
desktop-tauri/    Rust desktop shell and system integration
frontend/         Next.js chat UI, settings, artifacts, and SSE streaming
backend/          FastAPI agent engine, tool execution, LLM streaming, storage
```

**Quick Start:**

```bash
npm run dev:all
```

This starts the backend on port `8000` and the frontend on port `3000`. For deeper setup notes, see [frontend/README.md](frontend/README.md) and [backend/README.md](backend/README.md).

## FAQ

<details>
<summary>Does my data leave my machine?</summary>

Files, conversations, memory, and generated artifacts are stored locally. If you use a cloud model, the prompt and relevant context are sent directly to the model provider you selected. You can also use local Rapid-MLX or Ollama models for offline work.
</details>

<details>
<summary>Do I need an OpenYak account?</summary>

No. OpenYak does not require an OpenYak account, login, billing profile, or recharge flow. OpenYak also does not provide built-in model provider accounts; OpenRouter and other cloud providers require your own API key. You can connect a ChatGPT subscription or run local models depending on your setup.
</details>

<details>
<summary>How is OpenYak different from ChatGPT or Claude.ai?</summary>

OpenYak runs on your desktop and is designed around local files, artifacts, tools, and workflow continuity. Web chat products are great assistants; OpenYak is closer to a local workbench for files and repeatable office tasks.
</details>

<details>
<summary>Can I use it offline?</summary>

Yes. On Apple Silicon macOS, use Rapid-MLX with a downloaded MLX model. On macOS, Windows, or Linux, install Ollama and download a model. OpenYak can then run without cloud model calls.
</details>

<details>
<summary>How does remote access work?</summary>

Enable remote access in settings, scan the QR code, and open the mobile web client. OpenYak connects through Cloudflare Tunnel with token-based authentication, so you do not need port forwarding.
</details>

## Community

- **Questions and Discussions:** [GitHub Discussions](https://github.com/openyak/openyak/discussions)
- **Bug Reports:** [GitHub Issues](https://github.com/openyak/openyak/issues)
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md)

## License

[MIT](LICENSE)
