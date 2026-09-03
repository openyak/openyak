# OpenYak

<p align="center">
  <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/lang-中文-blue?style=flat-square" alt="中文" /></a>
  <a href="https://github.com/openyak/openyak/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/openyak/openyak/ci.yml?branch=main&style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://github.com/openyak/openyak/blob/main/LICENSE"><img src="https://img.shields.io/github/license/openyak/openyak?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/status-v2%20alpha-orange?style=flat-square" alt="Status: v2 alpha" />
</p>

<h3 align="center">Project → Task → Chat. Served by the coding agents you already have.</h3>

<p align="center">
  One workbench for Claude Code, Codex, and whatever comes next. Switch agents mid-task without losing the thread.
</p>

---

> **OpenYak is being rebuilt.** This branch is v2, an early alpha with a new direction.
> The v1 line (local-first desktop agent with its own runtime, Computer Use, and office
> workflows) is preserved unchanged on the [`legacy/v1`](https://github.com/openyak/openyak/tree/legacy/v1)
> branch and the [v1.5.0 release](https://github.com/openyak/openyak/releases/tag/v1.5.0).
> See the [announcement](https://github.com/openyak/openyak/discussions/190) for why.

## The idea

Claude Code, Codex, Gemini CLI, and the rest are converging on the same UI and the same
job. Each one wants to be your whole workbench. OpenYak takes the other side of that bet:

- **You already have the agents.** OpenYak does not ship a model runtime, tools, or
  provider keys. It drives the CLIs you installed and logged into, through the open
  [Agent Client Protocol](https://agentclientprotocol.com).
- **Tasks, not vendors.** Work is organized as Project → Task → Chat. The agent is a
  choice you make per message, not a product you commit to.
- **Switch without losing the thread.** OpenYak keeps the canonical transcript. When you
  hand a task from Codex to Claude Code, the new agent gets exactly the turns it missed.
- **One thing, done well.** No plugins, no browser automation, no document pipeline.
  Anything an agent can do itself is the agent's job.

## Status

v2 is an alpha. It runs, it is not yet polished, and the shape will change. What works:

- Projects (a directory), Tasks inside a project, one Chat per task
- Chat served by `claude` (via `@agentclientprotocol/claude-agent-acp`) or `codex`
  (via `@agentclientprotocol/codex-acp`), selectable per message
- Streaming text, thoughts, tool calls, and permission prompts from the agent
- Agent handoff: switch agents inside a task and keep the context
- The agent's own session options (model, reasoning effort, permission mode, …) in the
  chat header, exactly as the agent exposes them, remembered per task

Not yet: packaged installers, Grok and other agents, Linux and Windows testing.

## Run it

Prerequisites: Node 26 and Rust 1.90 (`mise install` sets both up), plus at least one of
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) or
[Codex CLI](https://github.com/openai/codex) on your `PATH` and logged in.

```bash
git clone https://github.com/openyak/openyak.git
cd openyak
npm install
npm run dev
```

`npm run dev` builds the Rust core and launches the Electron app in development mode.

## How it is built

```
app/    Electron + React     — Projects, Tasks, Chat UI. Talks only to core.
core/   Rust (openyak-core)  — SQLite transcript store + ACP client that spawns agents.
docs/   architecture.md, core-protocol.md
```

Read [`docs/architecture.md`](docs/architecture.md) for the process model and how
agent switching keeps the transcript coherent, and [`docs/core-protocol.md`](docs/core-protocol.md)
for the app ⇄ core contract.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The fastest way to help right now is to use it on a
real task with both agents and file what breaks.

## License

Apache-2.0. See [LICENSE](LICENSE).
