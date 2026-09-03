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
- The app is rebuilt around the chat: a collapsible sidebar with projects and their
  chats (most recent first), a single thread with rendered markdown, user bubbles, and
  compact tool rows, and a composer whose pills are the agent, its permission mode,
  model, and effort. Light and dark follow the system. A new chat is created from its
  first message; the sidebar time shows the task's last activity. A new chat is a real
  task from the moment its project is chosen, so the agents' sessions and options are
  live before anything is sent; it is named by its first message and deleted if left
  unsent.
- Attachments: paste or drop images and files into the composer, or pick files and
  folders from the "+" menu. Images reach the agent as ACP image blocks, files and folders
  as `file://` links it opens itself.
- Model, effort, and agent share one picker: a card with the current model and an
  animated slider whose stops are the effort levels the agent offers; the model list
  groups every installed agent's models, so picking a model from another agent is how
  you switch agents. The permission-mode pill takes its icon and colour from the kind
  the agent tags the mode with.
- OpenYak is now a Project → Task → Chat workbench that drives installed coding agents
  (Claude Code, Codex) through the Agent Client Protocol. It no longer ships its own
  agent runtime, tools, providers, Computer Use, office pipeline, plugins, or remote access.
- New stack: Rust core (`core/`) + Electron/React app (`app/`). The FastAPI backend,
  Next.js frontend, and Tauri shell are retired.

### Added
- Agent switching within one Task, with transcript handoff so the thread stays coherent.
- Agent session options (model, reasoning effort, permission mode, …) shown in the Chat
  header exactly as the agent advertises them over ACP, and passed back untouched.
  Choices are remembered per Task and agent and re-applied to fresh sessions.
- Agent sessions are resumed across restarts (ACP `session/load`) when the agent
  supports it; otherwise the fresh session gets the whole thread as a handoff.

### Fixed
- After a restart, or when an adapter was re-spawned, an agent could be prompted as if it
  had already seen the Chat, so it answered with no context. The handoff is now built for
  the session the prompt actually goes to.
- A reply left `streaming` by a previous core process is marked cancelled on startup.
