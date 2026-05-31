# Contributing to OpenYak

Thanks for your interest in contributing! This guide covers the workflow and conventions for the project.

## Getting Started

```bash
# Clone and install
git clone https://github.com/openyak/openyak.git
cd openyak
npm install
cd backend && pip install -e ".[dev]" && cd ..

# Run full stack
npm run dev:all
```

See [README.md](README.md) for detailed setup instructions.

## Development Workflow

### 1. Pick an Issue

- Browse [open issues](https://github.com/openyak/openyak/issues)
- Issues labeled `good first issue` are great starting points
- Comment on the issue to let others know you're working on it

### 2. Create a Branch

```bash
git checkout -b fix/short-description    # for bug fixes
git checkout -b feat/short-description   # for features
git checkout -b refactor/short-description
```

### 3. Make Changes

- Keep changes focused — one issue per PR
- Follow existing code patterns and conventions
- Add tests for bug fixes when possible

### 4. Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:**

| Type | When to use |
|------|-------------|
| `fix` | Bug fix |
| `feat` | New feature |
| `refactor` | Code change that doesn't fix a bug or add a feature |
| `docs` | Documentation only |
| `test` | Adding or updating tests |
| `chore` | Build, CI, tooling changes |
| `perf` | Performance improvement |

**Scopes:** `frontend`, `backend`, `desktop`, `ollama`, `mcp`

**Examples:**

```
fix(frontend): prevent duplicate sends on rapid double-click
feat(backend): add per-connector error isolation in MCP startup
refactor(frontend): extract draft persistence into module-level cache
docs: add contributing guide and issue templates
```

**Footer — link issues:**

```
fix(frontend): abort generation when switching sessions

Previously, navigating to a different session during active generation
left the backend agent loop running. Now ChatView calls stopGeneration()
in its cleanup effect.

Fixes #42
```

### 5. Submit a Pull Request

- Fill out the [PR template](.github/pull_request_template.md)
- Link the issue with `Fixes #N`
- Ensure checks pass:
  - `npx tsc --noEmit` (TypeScript)
  - `pytest` (Backend tests)

### 6. Code Review

- Respond to review comments
- Keep the PR up to date with `main` via rebase
- Once approved, a maintainer will merge

## Community Guidelines

OpenYak uses issue templates and moderation tools to keep project discussions useful for contributors and users.

- Follow the [Code of Conduct](CODE_OF_CONDUCT.md)
- Keep issues specific, respectful, and actionable
- Do not post spam, advertising, harassment, abuse, or automated low-quality content
- Do not report security vulnerabilities in public issues; follow [SECURITY.md](SECURITY.md)
- Maintainers may close, hide, delete, lock, or report content that harms the project community

## Code Conventions

### Frontend (TypeScript / React)

- Functional components with hooks
- Zustand for client state, TanStack Query for server state
- Tailwind CSS for styling (no CSS modules)
- `useRef` for synchronous guards (not `useState`)
- Module-level state for cross-mount persistence (not localStorage for ephemeral data)

### Backend (Python / FastAPI)

- Async everywhere (aiosqlite, async sessions)
- Pydantic for schemas and settings
- Follow existing error handling patterns (try/catch per operation, log + continue)
- ULID primary keys
- SQLAlchemy async ORM

### General

- No over-engineering — solve the problem at hand
- Prefer editing existing files over creating new ones
- Keep PRs small and focused
- Comments only where the logic isn't self-evident

## Reporting Bugs

Use the [Bug Report template](https://github.com/openyak/openyak/issues/new?template=bug_report.yml). A good bug report includes:

1. Clear description of what happened
2. Steps to reproduce
3. Expected vs actual behavior
4. Environment info (OS, version, provider)

## Requesting Features

Use the [Feature Request template](https://github.com/openyak/openyak/issues/new?template=feature_request.yml). Explain the problem before the solution — understanding *why* helps us design the right approach.

## Project Structure

```
desktop/
├── backend/        Python FastAPI — agent engine
├── frontend/       Next.js 15 — chat UI
├── desktop-tauri/  Tauri v2 (Rust) — desktop shell
├── .github/        Issue templates, PR template, labels
├── ISSUES.md       Internal issue tracker (being migrated to GitHub Issues)
├── CLAUDE.md       AI assistant context
└── CONTRIBUTING.md This file
```

## License

By contributing, you agree that your contributions will be licensed under the project's [license](LICENSE).
