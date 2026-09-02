# Contributing to OpenYak

Thanks for helping. OpenYak v2 is early; the fastest way to help is to use it on a real
task with Claude Code and Codex and file what breaks.

## Setup

Prerequisites: Node 26, Rust 1.90 (`mise install` handles both), plus at least one of
`claude` or `codex` on your `PATH` and logged in.

```bash
npm install
npm run dev          # builds core, starts Electron with hot reload
```

```bash
npm run check        # cargo test + tsc + eslint, same as CI
```

## Scope

v2 is deliberately narrow: Project → Task → Chat, served by external ACP agents. Read
`docs/architecture.md` before proposing a feature. Anything an agent can do itself is
out of scope for OpenYak.

## Pull requests

- One change per PR, with the reasoning in the description.
- `npm run check` must pass.
- Follow the vocabulary in `CONTEXT.md`.

Looking for the v1 codebase? It lives on the `legacy/v1` branch.
