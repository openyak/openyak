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
  <img src="docs/readme/openyak-computer-use.gif" width="900" alt="OpenYak switches between a native Computer workspace and a managed Browser, with live view and shared control between the Agent and user" />
</p>

<h3 align="center">A local-first agent runtime for reliable tool-using models, with a desktop workspace built on top.</h3>

<p align="center">
  Run an agent on your own computer, work across local files, native apps, and a managed Browser, and choose local or cloud models on your terms.
</p>

---

## Why OpenYak

OpenYak is built for people who want an AI agent that lives on their machine instead of behind another hosted workspace account.

- **No OpenYak account.** Install the app, choose a local model or bring your own provider key, and start working without login, billing, seats, or recharge flows.
- **Local-first agent runtime.** Files, conversations, memory, generated artifacts, tool permissions, and workflow state stay on your device.
- **Work from your actual files.** Attach DOCX, XLSX, PPTX, PDFs, CSVs, and local project context, then ask for briefs, tables, follow-ups, plans, and reusable artifacts.
- **Let the Agent use apps and websites.** Watch a shared live Computer or Browser workspace, take over for a delicate step, then return control without restarting the task.
- **Keep the workflow in one thread.** Start with analysis, continue into a RACI, ask for a follow-up email, and preserve context across long conversations.
- **Choose your model boundary.** Run local models through [Rapid-MLX](https://github.com/raullenchai/Rapid-MLX) or [Ollama](https://ollama.com), or opt into direct BYOK calls to OpenRouter, OpenAI, Anthropic, Google, and other providers.
- **Use your desktop agent from another device.** Remote access lets you scan a QR code and send tasks to your computer through a secure tunnel.

## Computer Use, with You in Control

> **New in the [v1.5 release candidate](https://github.com/openyak/openyak/releases/tag/v1.5.0-rc.2).** Native Computer currently ships for macOS and Windows. The rest of OpenYak continues to support Linux, but Linux Computer Use is not a v1.5 release gate.

OpenYak gives the Agent two purpose-built, shared workspaces instead of treating every interface as a stream of blind coordinate clicks:

- **Native Computer:** work in macOS and Windows applications through accessibility elements first, with a live app view, target-app selector, and coordinate input only as a fallback.
- **Managed Browser:** navigate and interact with websites in a dedicated OpenYak browser profile using tabs, page elements, screenshots, dialogs, and browser diagnostics.
- **Shared control:** follow the Agent's work live, choose **Take over** to click, type, or scroll yourself, then choose **Return to Agent** to continue the same task.
- **Scoped permissions:** approve native access per application and Browser access per website origin. Credentials stay user-entered, and consequential actions still require confirmation. The managed Browser remains separate from your everyday signed-in Chrome profile.

Choose **Use → Computer** to pin the task to a native app, **Browser** to pin it to the managed Browser, or **Auto** to let the Agent choose the appropriate tools for that turn. The selected mode stays visible in the composer, and every Computer or Browser tool observation identifies the active surface before you open its live workspace. For example:

```text
Review the launch checklist, switch to Notes, then verify the release page in the Browser.
Keep me in the live workspace and hand control back whenever I take over.
```

The demo uses sample apps and websites whose approvals are already granted so the short walkthrough can show the actual task sequence: user message, streaming Agent response, Computer and Browser tool observations, opening each live workspace, takeover and return, then the Agent's final verification. In normal use, macOS asks for Accessibility and Screen Recording access; Windows keeps the target app visible on the active desktop, and UAC secure desktop is outside the runtime. If you select a cloud model, the relevant app or page state needed for the task is sent directly to that provider as model context.

Read the [Computer Use architecture, supported actions, safety model, and platform status](docs/computer-use.md).

## What It Feels Like

| Ask OpenYak to... | It should give you... |
|-------------------|------------------------|
| Read a long memo | Executive brief, risks, owners, next actions, and a send-ready email |
| Analyze a workbook | Budget vs. actual variance, drivers, anomalies, and finance talking points |
| Review a deck | Slide-by-slide story, evidence gaps, speaker notes, and decision ask |
| Synthesize several files | One board brief that reconciles memo, budget, deck, and PDF context |
| Work in a native app or website | A shared live workspace where the Agent acts and you can take over at any time |
| Split work across agents | Parallel child-agent tasks with links back to each focused session |
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
  <img src="docs/readme/openyak-workflow-artifacts.gif" width="900" alt="OpenYak turns uploaded office files into a structured answer and reusable artifact" />
</p>

<p align="center">
  <img src="docs/readme/openyak-artifact-panel.png" width="900" alt="OpenYak artifact panel with a multi-file board brief" />
</p>

### Ultra Agent Swarm

Turn on Ultra for complex work and describe the goal normally. The parent Agent decides when to launch 2–4 focused AgentRuns in durable child Sessions, follows their live state, exchanges input when needed, and synthesizes their persisted results in the original task. There is no task-batch form to configure.

The parent-scoped Subagents view keeps Active and Done work inside the same task shell. Open a child transcript, inspect its status and output, then return to the parent while Progress, Outputs, Subagents, Sources, Inputs, and Context stay tied to the same task.

<p align="center">
  <img src="docs/readme/openyak-subagents-work-view.png" width="900" alt="OpenYak Subagents work view with Active and Done child Sessions and task-level Outputs" />
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
> To try Computer Use now, download the [v1.5 release candidate](https://github.com/openyak/openyak/releases/tag/v1.5.0-rc.2).
>
> Linux users can also read [LINUX.md](LINUX.md) for requirements and troubleshooting.

## Get Started

1. **Install OpenYak** for your platform.
2. **Choose where inference runs:** local Rapid-MLX/Ollama for offline work, or a BYOK cloud provider when you want hosted models.
3. **Start a new conversation** and attach a real file, or choose **Use → Computer / Browser** for an interactive task.
4. **Ask for a deliverable**, not just a summary: brief, action plan, RACI, email, table, artifact, or a completed app workflow.
5. **Follow the work live.** Review the result, take over when needed, and continue in the same thread.

Example prompt:

```text
Please read the files I uploaded and turn them into a concise team brief.
Start with three key takeaways, then list risks, owners, and next actions.
Finally, write a follow-up email I can send to the team directly.
```

## Model Options

### Local First

- **Rapid-MLX:** Apple Silicon macOS users can start and switch curated MLX models from Settings. OpenYak connects to Rapid-MLX's OpenAI-compatible API on `localhost`.
- **Ollama:** Run any model available through [Ollama](https://ollama.com). Local models are auto-detected and can be used without an internet connection.
- **Custom local endpoints:** Point OpenYak at a local OpenAI-compatible server when you run your own model stack.

### Optional Cloud Providers

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
| Together AI | BYOK | Direct provider key |
| DeepInfra | BYOK | Direct provider key |
| Cerebras | BYOK | Fast hosted inference |
| Cohere | BYOK | Command models |
| Perplexity | BYOK | Sonar models |
| Fireworks AI | BYOK | Direct provider key |
| Azure OpenAI | BYOK | Your own Azure deployment |
| SiliconFlow | BYOK | Direct provider key |
| Xiaomi MiMo | BYOK | Direct provider key |
| ChatGPT | Subscription | Use an existing ChatGPT Plus, Pro, Team, or Enterprise plan when available |

Any provider not listed above can still be used through a custom OpenAI-compatible endpoint. Cloud and subscription paths are optional. OpenYak does not provide hosted model accounts and does not proxy model traffic; requests go directly from your desktop to the provider you configure.

## Core Capabilities

- **File understanding:** office docs, spreadsheets, slide decks, PDFs, CSVs, local folders, and generated artifacts.
- **Artifact workspace:** reusable Markdown briefs, tables, diagrams, checklists, and structured outputs.
- **Tool execution:** read, write, rename, organize, and automate files with user-controlled permissions.
- **Computer Use:** shared native-app and managed-Browser workspaces with live view, scoped approval, target switching, and user takeover.
- **Long-context work:** continue from analysis to planning to follow-up without starting over.
- **Remote access:** connect from mobile through QR code and Cloudflare Tunnel.
- **Automations:** schedule recurring cleanup, reporting, and file workflows.
- **Privacy controls:** local storage, no OpenYak account, BYOK provider access, and local model support.

## Agent Runtime Engineering

OpenYak is also an open-source ML systems project. The desktop application is
built on a durable agent runtime designed to make tool-using models observable,
recoverable, and safe to run against local resources.

- **Production engineering:** persisted run state, resumable SSE streams,
  cancellation, bounded retries, and child-run failure isolation.
- **Tool execution:** machine-readable tool schemas, argument validation,
  malformed-call repair, execution feedback, and output budgeting.
- **Permissions:** layered allow/ask/deny policies, resource-scoped approval,
  workspace boundaries, and secret-aware permission displays.
- **Context:** model-aware token budgets, tool-output compression, deterministic
  context collapse, and persisted LLM summaries.
- **Cross-platform architecture:** Tauri and Next.js on macOS, Windows, and
  Linux, backed by one FastAPI runtime and a shared local/cloud provider contract.
- **Open-source adoption:** public releases, contributors, issues, and stars are
  tracked separately from model-quality claims, which require reproducible evals.

Read the evidence-backed [Agent Runtime case study](AGENT_RUNTIME.md), then see
[model training and routing](MODEL_TRAINING.md), the [evaluation protocol](EVALUATION.md),
[benchmark contract](BENCHMARKS.md), and [failure analysis](FAILURE_ANALYSIS.md).

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

Files, conversations, memory, generated artifacts, and workflow state are stored locally. If you use Rapid-MLX, Ollama, or another local endpoint, model requests stay on your machine. If you choose a cloud model, the prompt and relevant context are sent directly from your desktop to the model provider you selected.
</details>

<details>
<summary>Do I need an OpenYak account?</summary>

No. OpenYak does not require an OpenYak account, login, billing profile, recharge flow, team workspace, or hosted OpenYak backend. Cloud providers, when used, require your own API key or existing subscription.
</details>

<details>
<summary>How is OpenYak different from ChatGPT or Claude.ai?</summary>

OpenYak runs on your desktop and is designed around local files, artifacts, tools, permissions, and workflow continuity. Web chat products are great assistants; OpenYak is closer to a local agent workbench that can inspect files, use tools, and keep long-running work tied to your machine.
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

[Apache-2.0](LICENSE)
