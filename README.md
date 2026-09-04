# OpenYak

<p align="center">
  <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/lang-中文-blue?style=flat-square" alt="中文" /></a>
  <a href="https://github.com/openyak/openyak/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/openyak/openyak/ci.yml?branch=main&style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://github.com/openyak/openyak/blob/main/LICENSE"><img src="https://img.shields.io/github/license/openyak/openyak?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/status-v2%20alpha-orange?style=flat-square" alt="Status: v2 alpha" />
</p>

<h3 align="center">One chat. Every agent.</h3>

<p align="center">
  A universal interface for AI agents running on your computer.
</p>

---

> **OpenYak is being rebuilt.** This branch is v2, an early alpha with a new direction.
> The v1 line (local-first desktop agent with its own runtime, Computer Use, and office
> workflows) is preserved unchanged on the [`legacy/v1`](https://github.com/openyak/openyak/tree/legacy/v1)
> branch and the [v1.5.0 release](https://github.com/openyak/openyak/releases/tag/v1.5.0).
> See the [announcement](https://github.com/openyak/openyak/discussions/190) for why.

## The idea

**You shouldn't have to choose an AI app. Just say what you want done.**

Claude Code, Codex, Gemini, and whatever ships next month each want to be the app you
live in. OpenYak treats them as what they are becoming: **runtime providers**. Each one
brings its own model, tools, permissions, and login. What none of them gives you is the
layer above: one conversation that belongs to you, that any of them can pick up, and
that does not end when you change your mind about who should do the work.

That is the whole product. Not an aggregator of AI apps, but the place where the AI app
stops mattering.

- **The chat is yours.** OpenYak keeps the transcript. Agents come and go; the thread
  does not.
- **Agents are runtimes.** OpenYak ships no model, no tools, no keys, and no permission
  engine. It drives the agents you already installed and logged into, through the open
  [Agent Client Protocol](https://agentclientprotocol.com), and shows their options and
  their permission prompts exactly as they expose them.
- **Switching is free.** Hand a task from Codex to Claude Code mid-thread. The new agent
  gets the turns it missed and continues. No copy-paste, no new chat, no terminal.
- **Where this goes.** Today you pick the agent per message. The direction is that you
  stop noticing which one did the work, the way you never think about which CPU core your
  browser used.

## Status

v2 is an alpha. It runs, it is not yet polished, and the shape will change. What works:

- One persistent chat per task, kept by OpenYak, not by any agent. Tasks live inside a
  Project (a directory on disk that the agents run in).
- Chat served by `claude` (via `@agentclientprotocol/claude-agent-acp`) or `codex`
  (via `@agentclientprotocol/codex-acp`), selectable per message
- Streaming text, thoughts, tool calls, and permission prompts from the agent
- Agent handoff: switch agents inside a task and keep the context, including across
  restarts
- The agent's own session options (model, reasoning effort, permission mode, …) in the
  chat header, exactly as the agent exposes them, remembered per task

Not yet: packaged installers; more agents (Gemini CLI, Grok, anything else that speaks
ACP); picking the agent for you; Linux and Windows testing.

## Run it

Prerequisites: Node 26 and Rust 1.90 (`mise install` sets both up), and a sign-in to
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` once) and/or
[Codex](https://github.com/openai/codex) (`codex login`) on this machine. The agents
themselves ship inside the app; only the sign-in is yours.

```bash
git clone https://github.com/openyak/openyak.git
cd openyak
npm install
npm run dev
```

`npm run dev` builds the Rust core and launches the Electron app in development mode.

## How it is built

```
app/    Electron + React     — the chat, plus Projects and Tasks around it. Talks only to core.
core/   Rust (openyak-core)  — SQLite transcript store + ACP client that spawns agents.
docs/   architecture.md, core-protocol.md
```

Read [`docs/architecture.md`](docs/architecture.md) for the process model and how
agent switching keeps the transcript coherent, and [`docs/core-protocol.md`](docs/core-protocol.md)
for the app ⇄ core contract.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The fastest way to help right now is to use it for
something real, switch agents in the middle, and file what breaks.

## License

Apache-2.0. See [LICENSE](LICENSE).
