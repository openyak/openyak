[中文](README.zh-CN.md)

# OpenYak Backend

Python FastAPI backend that replicates OpenCode's complete agent architecture, bringing Claude Code-level agentic capabilities to open-source models via OpenRouter.

## Quick Start

```bash
# 1. Install dependencies
pip install -e ".[dev]"

# 2. Configure environment
cp .env.example .env
# Edit .env — set OPENYAK_OPENROUTER_API_KEY

# 3. Start the server
uvicorn app.main:app --reload
```

After startup:
- API docs: http://localhost:8000/docs
- Health check: http://localhost:8000/health

## Architecture

```
app/
├── main.py              # FastAPI entry + lifespan
├── config.py            # Pydantic Settings configuration
├── dependencies.py      # FastAPI dependency injection
│
├── agent/               # Agent system (7 built-in agents)
│   ├── agent.py         #   AgentRegistry + build/plan/explore/general/compaction/title/summary
│   ├── permission.py    #   4-layer permission engine (global → agent → user → session)
│   └── prompts/         #   System prompt templates per agent
│
├── tool/                # Tool system (20+ built-in tools)
│   ├── base.py          #   ToolDefinition ABC + ToolResult
│   ├── context.py       #   ToolContext (permission checks, abort, metadata)
│   ├── registry.py      #   ToolRegistry (per-agent permission filtering)
│   ├── truncation.py    #   Output truncation (~30K chars)
│   └── builtin/         #   read, write, edit, bash, glob, grep, task, question, todo,
│                        #   web_fetch, web_search, code_execute, artifact, plan, skill,
│                        #   memory, apply_patch, search, submit_plan, ...
│
├── session/             # Core execution loop
│   ├── processor.py     #   THE CORE — full agent loop (multi-step tool calling, doom loop
│   │                    #   detection, tool fixing, permission gating)
│   ├── manager.py       #   Session/Message CRUD + LLM message history construction
│   ├── compaction.py    #   Two-stage context compression (trim + LLM summarization)
│   ├── system_prompt.py #   System prompt construction
│   ├── llm.py           #   LLM streaming bridge
│   ├── retry.py         #   Exponential backoff retry
│   └── title.py         #   Auto-generate session titles
│
├── provider/            # LLM providers (21 BYOK + Ollama + ChatGPT subscription)
│   ├── base.py          #   BaseProvider ABC
│   ├── openai_compat.py #   OpenAI-compatible base class
│   ├── openrouter.py    #   OpenRouter (primary provider, reasoning model support)
│   ├── ollama.py        #   Ollama local LLM (extends OpenAI-compat)
│   ├── anthropic_provider.py # Native Anthropic SDK provider
│   ├── gemini_provider.py #  Native Google Gemini SDK provider
│   ├── generic_openai.py #   Generic OpenAI-compatible provider (BYOK)
│   ├── catalog.py       #   Provider catalog (21 BYOK provider definitions)
│   ├── factory.py       #   Provider factory (creates providers from catalog)
│   ├── openai_oauth.py  #   ChatGPT subscription OAuth
│   ├── openai_subscription.py # ChatGPT subscription provider
│   ├── registry.py      #   ProviderRegistry
│   └── tool_calling/    #   Tool calling adapters (native FC detection + prompt-based fallback)
│
├── ollama/              # Ollama runtime management
│   ├── manager.py       #   Binary download, process lifecycle (start/stop/health)
│   └── library.py       #   Model library (live search from ollama.com + local fallback)
│
├── streaming/           # Resumable SSE streams
│   ├── events.py        #   SSEEvent types + encoding
│   └── manager.py       #   GenerationJob + StreamManager (reconnection support)
│
├── models/              # SQLAlchemy ORM
│   ├── base.py          #   DeclarativeBase + TimestampMixin + ULID primary keys
│   ├── project.py       #   Project table
│   ├── session.py       #   Session table
│   └── message.py       #   Message + Part tables (JSON data column)
│
├── schemas/             # Pydantic v2 request/response models
├── storage/             # Database engine + generic CRUD
├── api/                 # FastAPI routes (26 modules)
├── connector/           # MCP connector management
├── mcp/                 # MCP integration
│   ├── client.py        #   MCP client connections (stdio, SSE, HTTP)
│   ├── manager.py       #   MCP server lifecycle management
│   ├── oauth.py         #   OAuth flow for MCP servers
│   ├── token_store.py   #   Token persistence
│   └── tool_wrapper.py  #   Wrap MCP tools as agent tools
├── openclaw/            # OpenClaw IM bridge
│   └── manager.py       #   Binary lifecycle + WebSocket to OpenClaw gateway
├── memory/              # Long-term memory system
│   ├── config.py        #   Memory configuration
│   ├── models.py        #   Fact & context ORM models
│   ├── storage.py       #   Memory CRUD operations
│   ├── queue.py         #   Post-conversation extraction queue
│   ├── injection.py     #   System prompt memory injection
│   └── updater.py       #   Fact extraction & update logic
├── skill/               # Skill system (bundled + project-scoped)
├── plugin/              # Plugin system (load/enable/disable)
├── fts/                 # Full-text search (SQLite FTS5)
├── scheduler/           # Background task scheduler (cron + automations)
├── auth/                # Authentication & remote tunnel
└── utils/               # ULID, token counting, diff
```

## Agents

| Agent | Type | Description |
|-------|------|-------------|
| `build` | Primary | Full-featured assistant with all tools; asks permission for bash/write/edit |
| `plan` | Primary | Read-only analysis mode (denies write/edit/bash) |
| `explore` | Subagent | Fast search & exploration (read/glob/grep/bash/web) |
| `general` | Subagent | General-purpose with full tool access |
| `compaction` | Hidden | Context summarization (no tools) |
| `title` | Hidden | Auto-generates session titles |
| `summary` | Hidden | Computes summary statistics |

## Tools

| Tool | Description |
|------|-------------|
| `read` | Read file contents (with pagination) |
| `write` | Create/write files |
| `edit` | Edit file ranges (with diff viewer) |
| `apply_patch` | Apply unified diffs |
| `bash` | Execute shell commands |
| `code_execute` | Run Python in isolated sandbox |
| `glob` | File pattern matching |
| `grep` | Content search with regex |
| `search` | Full-text search (FTS5) |
| `question` | Ask user for input (blocking) |
| `todo` | Manage task todo list |
| `task` | Launch subtask (recursive agent) |
| `plan` | Switch to plan mode (read-only) |
| `submit_plan` | Submit plan for execution |
| `artifact` | Store/retrieve content blocks |
| `skill` | Execute bundled/plugin skills |
| `web_fetch` | Fetch & parse web pages |
| `web_search` | Web search (daily quota) |
| `memory` | Manage long-term memory (search/save/update/forget facts and context) |
| `invalid` | Fallback for malformed tool calls |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (includes provider status) |
| POST | `/api/chat/prompt` | Start generation → returns `{stream_id, session_id}` |
| GET | `/api/chat/stream/{id}` | SSE stream (supports `?last_event_id=N` reconnection) |
| POST | `/api/chat/edit` | Edit user message, delete subsequent, re-generate |
| POST | `/api/chat/abort` | Abort generation |
| GET | `/api/chat/active` | List active generation jobs |
| POST | `/api/chat/respond` | User responds to question tool / permission request |
| GET/POST | `/api/sessions` | List / create sessions |
| GET/PATCH/DELETE | `/api/sessions/{id}` | View / update / delete session |
| GET | `/api/sessions/search` | Search sessions by title & content |
| GET | `/api/sessions/{id}/export-pdf` | Export conversation as PDF |
| GET | `/api/messages/{session_id}` | Get session messages + parts |
| GET | `/api/agents` | List agents |
| GET | `/api/models` | List available models (all providers) |
| GET | `/api/tools` | List tools |
| GET | `/api/skills` | List skills |
| POST | `/api/files/upload` | Upload files |
| GET/POST | `/api/config` | Get/set app configuration |
| GET | `/api/usage` | Token usage tracking |
| GET | `/api/ollama/status` | Ollama runtime status (binary, running, version) |
| POST | `/api/ollama/setup` | Download Ollama binary + start server (SSE progress) |
| POST | `/api/ollama/start` | Start Ollama server |
| POST | `/api/ollama/stop` | Stop Ollama server |
| GET | `/api/ollama/models` | List locally installed Ollama models |
| GET | `/api/ollama/models/library` | Browse model library (search, sort, paginate) |
| POST | `/api/ollama/models/pull` | Download a model (SSE progress) |
| DELETE | `/api/ollama/models/{name}` | Delete a local model |
| DELETE | `/api/ollama/uninstall` | Remove Ollama binary + optional models |
| | **Channels (OpenClaw)** | |
| GET | `/api/channels/openclaw/status` | OpenClaw runtime status |
| POST | `/api/channels/openclaw/setup` | Install OpenClaw binary (SSE progress) |
| POST | `/api/channels/login` | Start channel login (e.g., WhatsApp QR) |
| POST | `/api/channels/add` | Add channel with token/credentials |
| POST | `/api/channels/remove` | Remove a channel |
| GET | `/api/channels/list` | List connected channels |
| | **Memory** | |
| GET | `/api/memory` | Get all stored memory (contexts + facts) |
| POST | `/api/memory/facts` | Add a new fact |
| DELETE | `/api/memory/facts` | Remove facts by ID |
| PUT | `/api/memory/context` | Update a context section |
| GET/PUT | `/api/memory/config` | Get/update memory configuration |
| | **Automations** | |
| GET | `/api/automations/templates` | List built-in automation templates |
| POST | `/api/automations/from-template` | Create automation from template |
| GET/POST | `/api/automations` | List / create automations |
| GET/PATCH/DELETE | `/api/automations/{id}` | View / update / delete automation |
| POST | `/api/automations/{id}/trigger` | Manually trigger an automation |
| | **Connectors (MCP)** | |
| GET | `/api/connectors` | List all connectors with status |
| GET | `/api/connectors/{id}` | Get connector detail |
| POST | `/api/connectors/{id}/reconnect` | Reconnect a connector |
| | **Plugins** | |
| GET | `/api/plugins` | List available plugins |
| POST | `/api/plugins/{id}/enable` | Enable a plugin |
| POST | `/api/plugins/{id}/disable` | Disable a plugin |

## Core Agent Loop

```
User Input → Create UserMessage → Build system prompt → Resolve tools
    ↓
┌─ while True: ──────────────────────────────────────────┐
│  Load message history → Call LLM (streaming)           │
│    ├── text-delta → publish SSE + save TextPart        │
│    ├── reasoning-delta → publish SSE + save Reasoning  │
│    ├── tool-call → doom loop check → permission check  │
│    │     → execute tool                                │
│    │     ├── Tool fixing (case correction → invalid    │
│    │     │   fallback)                                 │
│    │     ├── Save ToolPart (input/output/state)        │
│    │     └── If task tool → launch sub-agent loop      │
│    └── usage → check context overflow → trigger        │
│          two-stage compression                         │
│                                                        │
│  No tool calls → break                                 │
│  Has tool calls → continue (LLM sees results, decides  │
│  next step)                                            │
└────────────────────────────────────────────────────────┘
    ↓
Auto-generate title on first turn → publish done event
```

## Permission System

4-layer hierarchical permission engine:

1. **Global** — Base rules for all agents
2. **Agent** — Per-agent ruleset
3. **User** — Session-scoped overrides
4. **Session** — Conversation-specific rules

Each tool can be set to `allow`, `deny`, or `ask` (prompts user in UI).

## LLM Providers

21 BYOK providers + Ollama local + ChatGPT subscription:

| Provider | Type | Notes |
|----------|------|-------|
| OpenRouter | Aggregator | Primary provider, 100+ models, reasoning token support |
| Ollama | Local | Managed binary lifecycle, auto-download, pre-warming |
| ChatGPT Subscription | OAuth | Connect existing ChatGPT Plus/Team subscription |
| OpenAI | BYOK | Direct API key |
| Anthropic | BYOK (native SDK) | Claude models via Anthropic SDK |
| Google Gemini | BYOK (native SDK) | Gemini models via Google GenAI SDK |
| Groq | BYOK | Fast inference |
| DeepSeek | BYOK | DeepSeek V3/R1 |
| Mistral | BYOK | Mistral/Mixtral models |
| xAI | BYOK | Grok models |
| Together AI | BYOK | Open-source model hosting |
| DeepInfra | BYOK | |
| Cerebras | BYOK | Ultra-fast inference |
| Cohere | BYOK | Command R+ |
| Perplexity | BYOK | Search-augmented models |
| Fireworks AI | BYOK | |
| Azure OpenAI | BYOK | Enterprise Azure deployment |
| Qwen (通义千问) | BYOK | Alibaba DashScope |
| Kimi (月之暗面) | BYOK | Moonshot |
| MiniMax | BYOK | |
| ZhipuAI (智谱) | BYOK | GLM models |
| SiliconFlow (硅基流动) | BYOK | |
| Xiaomi MiMo | BYOK | |

All BYOK provider keys follow the pattern `OPENYAK_{PROVIDER}_API_KEY`.

## Usage Examples

```bash
# Simple chat
curl -X POST http://localhost:8000/api/chat/prompt \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello!", "model": "z-ai/glm-4.7-flash"}'
# Returns: {"stream_id": "...", "session_id": "..."}

# Subscribe to SSE stream
curl -N http://localhost:8000/api/chat/stream/{stream_id}

# Tool calling (agent auto-invokes read/grep/etc.)
curl -X POST http://localhost:8000/api/chat/prompt \
  -H "Content-Type: application/json" \
  -d '{"text": "Read the file at ./app/main.py and explain what it does"}'

# List tools
curl http://localhost:8000/api/tools

# List agents
curl http://localhost:8000/api/agents
```

## Tech Stack

- **Python 3.12+** / FastAPI / Pydantic v2
- **SQLAlchemy** (async) + SQLite WAL
- **OpenAI SDK** → OpenRouter (reasoning token support)
- **Anthropic SDK** → native Anthropic provider
- **Google GenAI SDK** → native Gemini provider
- **MCP SDK** → Model Context Protocol client (optional)
- **SSE** resumable streaming
- **ULID** primary keys
- **tiktoken** token counting
- **PyInstaller** standalone build

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENYAK_OPENROUTER_API_KEY` | OpenRouter API key | (optional) |
| `OPENYAK_DATABASE_URL` | Database connection string | `sqlite+aiosqlite:///./data/openyak.db` |
| `OPENYAK_HOST` | Listen address | `0.0.0.0` |
| `OPENYAK_PORT` | Listen port | `8000` |
| `OPENYAK_DEBUG` | Debug mode | `false` |
| `OPENYAK_PROJECT_DIR` | Workspace root (for file operations) | `.` |
| `OPENYAK_COMPACTION_AUTO` | Auto context compression | `true` |
| `OPENYAK_DAILY_SEARCH_LIMIT` | Daily web search quota | `20` |
| `OPENYAK_FTS_ENABLED` | Full-text search indexing | `true` |
| `OPENYAK_OLLAMA_BASE_URL` | Ollama server URL (auto-set by setup) | `` |
| `OPENYAK_OLLAMA_AUTO_START` | Auto-start managed Ollama on launch | `true` |
| `OPENYAK_OLLAMA_LAST_MODEL` | Last-used model for startup pre-warming | `` |
| `OPENYAK_OPENCLAW_ENABLED` | Enable OpenClaw IM bridge | `false` |
| `OPENYAK_OPENCLAW_URL` | OpenClaw WebSocket URL | `ws://127.0.0.1:18789` |
| `OPENYAK_BRAVE_SEARCH_API_KEY` | Brave Search API key (enhanced web search) | `` |
| `OPENYAK_REMOTE_ACCESS_ENABLED` | Enable remote tunnel access | `false` |

## Build & Deploy

```bash
# Development
uvicorn app.main:app --reload

# Desktop mode (standalone entry point)
python run.py --port 8100 --data-dir /path/to/app/data

# Production (PyInstaller bundle)
pyinstaller openyak.spec
./dist/openyak
```
