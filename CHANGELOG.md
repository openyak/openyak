# Changelog

All notable changes to OpenYak are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The v1 line (1.1.1 – 1.5.0, the local-first desktop agent with its own runtime, tools,
Computer Use, and office workflows) is preserved unchanged on the
[`legacy/v1`](https://github.com/openyak/openyak/tree/legacy/v1) branch and at the
[`v1-final`](https://github.com/openyak/openyak/releases/tag/v1.5.0) tag, together with
its full changelog.

## [Unreleased] — 2.0.0-alpha

### Changed
- OpenYak is now a Project → Task → Chat workbench that drives installed coding agents
  (Claude Code, Codex) through the Agent Client Protocol. It no longer ships its own
  agent runtime, tools, providers, Computer Use, office pipeline, plugins, or remote access.
- New stack: Rust core (`core/`) + Electron/React app (`app/`). The FastAPI backend,
  Next.js frontend, and Tauri shell are retired.

### Added
- Agent switching within one Task, with transcript handoff so the thread stays coherent.
