[English](README.md)

# OpenYak 后端

Python FastAPI 后端，复刻 OpenCode 完整 agent 架构，让开源模型（通过 OpenRouter）拥有 Claude Code 级别的 agentic 能力。

## 快速开始

```bash
# 1. 安装依赖
pip install -e ".[dev]"

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 OPENYAK_OPENROUTER_API_KEY

# 3. 启动服务
uvicorn app.main:app --reload
```

服务启动后访问：
- API 文档：http://localhost:8000/docs
- 健康检查：http://localhost:8000/health

## 架构

```
app/
├── main.py              # FastAPI 入口 + lifespan
├── config.py            # Pydantic Settings 配置
├── dependencies.py      # FastAPI 依赖注入
│
├── agent/               # Agent 系统（7 个内置 agent）
│   ├── agent.py         #   AgentRegistry + build/plan/explore/general/compaction/title/summary
│   ├── permission.py    #   4 层权限引擎（全局 → agent → 用户 → 会话）
│   └── prompts/         #   每个 agent 的 system prompt 模板
│
├── tool/                # 工具系统（20+ 个内置工具）
│   ├── base.py          #   ToolDefinition ABC + ToolResult
│   ├── context.py       #   ToolContext（权限检查、abort、metadata）
│   ├── registry.py      #   ToolRegistry（按 agent 权限过滤）
│   ├── truncation.py    #   输出截断（~30K 字符）
│   └── builtin/         #   read, write, edit, bash, glob, grep, task, question, todo,
│                        #   web_fetch, web_search, code_execute, artifact, plan, skill,
│                        #   memory, apply_patch, search, submit_plan, ...
│
├── session/             # 核心执行循环
│   ├── processor.py     #   THE CORE — 完整 agent loop（多步工具调用、doom loop 检测、
│   │                    #   工具修复、权限门控）
│   ├── manager.py       #   Session/Message CRUD + LLM 消息历史构建
│   ├── compaction.py    #   两阶段上下文压缩（裁剪 + LLM 摘要）
│   ├── system_prompt.py #   系统提示词构建
│   ├── llm.py           #   LLM 流式调用桥接
│   ├── retry.py         #   指数退避重试
│   └── title.py         #   自动生成会话标题
│
├── provider/            # LLM 提供者（21 个 BYOK + Rapid-MLX + Ollama + ChatGPT 订阅）
│   ├── base.py          #   BaseProvider ABC
│   ├── openai_compat.py #   OpenAI 兼容基类
│   ├── openrouter.py    #   OpenRouter（主要提供者，支持 reasoning）
│   ├── ollama.py        #   Ollama 本地大模型（继承 OpenAI 兼容基类）
│   ├── rapid_mlx.py     #   Rapid-MLX 本地大模型（Apple Silicon，OpenAI 兼容）
│   ├── anthropic_provider.py # 原生 Anthropic SDK 提供者
│   ├── gemini_provider.py #  原生 Google Gemini SDK 提供者
│   ├── generic_openai.py #   通用 OpenAI 兼容提供者（BYOK）
│   ├── catalog.py       #   提供者目录（21 个 BYOK 提供者定义）
│   ├── factory.py       #   提供者工厂（从目录创建提供者）
│   ├── openai_oauth.py  #   ChatGPT 订阅 OAuth
│   ├── openai_subscription.py # ChatGPT 订阅提供者
│   ├── registry.py      #   ProviderRegistry
│   └── tool_calling/    #   工具调用适配（原生 FC 检测 + prompt-based 回退）
│
├── ollama/              # Ollama 运行时管理
│   ├── manager.py       #   二进制下载、进程生命周期（启动/停止/健康检查）
│   └── library.py       #   模型库（从 ollama.com 实时搜索 + 离线回退）
│
├── rapid_mlx/           # Rapid-MLX 运行时管理
│   ├── catalog.py       #   精选 MLX alias 与 vision 能力元数据
│   └── manager.py       #   进程生命周期、缓存检测、删除/启动/停止
│
├── streaming/           # 可恢复 SSE 流
│   ├── events.py        #   SSEEvent 类型 + 编码
│   └── manager.py       #   GenerationJob + StreamManager（支持断线重连）
│
├── models/              # SQLAlchemy ORM
│   ├── base.py          #   DeclarativeBase + TimestampMixin + ULID 主键
│   ├── project.py       #   Project 表
│   ├── session.py       #   Session 表
│   └── message.py       #   Message + Part 表（JSON data 列）
│
├── schemas/             # Pydantic v2 请求/响应模型
├── storage/             # 数据库引擎 + 通用 CRUD
├── api/                 # FastAPI 路由（26 个模块）
├── connector/           # MCP 连接器管理
├── mcp/                 # MCP 集成
│   ├── client.py        #   MCP 客户端连接（stdio、SSE、HTTP）
│   ├── manager.py       #   MCP 服务器生命周期管理
│   ├── oauth.py         #   MCP 服务器 OAuth 流程
│   ├── token_store.py   #   Token 持久化
│   └── tool_wrapper.py  #   将 MCP 工具封装为 agent 工具
├── openclaw/            # OpenClaw IM 桥接
│   └── manager.py       #   二进制生命周期 + WebSocket 连接 OpenClaw 网关
├── memory/              # 长期记忆系统
│   ├── config.py        #   记忆配置
│   ├── models.py        #   Fact & Context ORM 模型
│   ├── storage.py       #   记忆 CRUD 操作
│   ├── queue.py         #   对话后提取队列
│   ├── injection.py     #   系统提示词记忆注入
│   └── updater.py       #   Fact 提取 & 更新逻辑
├── skill/               # 技能系统（内置 + 项目级）
├── plugin/              # 插件系统（加载/启用/禁用）
├── fts/                 # 全文搜索（SQLite FTS5）
├── scheduler/           # 后台任务调度器（cron + 自动化任务）
├── auth/                # 认证 & 远程隧道
└── utils/               # ULID、token 计数、diff
```

## Agent 系统

| Agent | 类型 | 说明 |
|-------|------|------|
| `build` | 主 Agent | 全功能助手，拥有所有工具；bash/write/edit 需请求权限 |
| `plan` | 主 Agent | 只读分析模式（拒绝 write/edit/bash） |
| `explore` | 子 Agent | 快速搜索与探索（read/glob/grep/bash/web） |
| `general` | 子 Agent | 通用型，拥有所有工具访问权限 |
| `compaction` | 隐藏 | 上下文摘要压缩（无工具） |
| `title` | 隐藏 | 自动生成会话标题 |
| `summary` | 隐藏 | 计算摘要统计 |

## 工具系统

| 工具 | 说明 |
|------|------|
| `read` | 读取文件内容（支持分页） |
| `write` | 创建/写入文件 |
| `edit` | 编辑文件范围（带 diff 展示） |
| `apply_patch` | 应用 unified diff 补丁 |
| `bash` | 执行 shell 命令 |
| `code_execute` | 在隔离沙箱中运行 Python |
| `glob` | 文件模式匹配 |
| `grep` | 正则内容搜索 |
| `search` | 全文搜索（FTS5） |
| `question` | 向用户提问（阻塞等待） |
| `todo` | 管理待办列表 |
| `task` | 启动子任务（递归 agent） |
| `plan` | 切换到计划模式（只读） |
| `submit_plan` | 提交计划执行 |
| `artifact` | 存储/检索内容块 |
| `skill` | 执行内置/插件技能 |
| `web_fetch` | 抓取并解析网页 |
| `web_search` | 网页搜索（每日配额） |
| `memory` | 管理长期记忆（搜索/保存/更新/遗忘事实和上下文） |
| `invalid` | 格式错误工具调用的兜底处理 |

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查（含 provider 状态） |
| POST | `/api/chat/prompt` | 开始生成 → 返回 `{stream_id, session_id}` |
| GET | `/api/chat/stream/{id}` | SSE 流（支持 `?last_event_id=N` 断线重连） |
| POST | `/api/chat/edit` | 编辑用户消息，删除后续消息并重新生成 |
| POST | `/api/chat/abort` | 中止生成 |
| GET | `/api/chat/active` | 列出活跃任务 |
| POST | `/api/chat/respond` | 用户回复 question 工具 / 权限请求 |
| GET/POST | `/api/sessions` | 列表 / 创建会话 |
| GET/PATCH/DELETE | `/api/sessions/{id}` | 查看 / 更新 / 删除会话 |
| GET | `/api/sessions/search` | 按标题和内容搜索会话 |
| GET | `/api/sessions/{id}/export-pdf` | 导出对话为 PDF |
| GET | `/api/messages/{session_id}` | 获取会话消息 + parts |
| GET | `/api/agents` | 列出 agent |
| GET | `/api/models` | 列出可用模型（所有 provider） |
| GET | `/api/tools` | 列出工具 |
| GET | `/api/skills` | 列出技能 |
| POST | `/api/files/upload` | 上传文件 |
| GET/POST | `/api/config` | 获取/设置应用配置 |
| GET | `/api/usage` | Token 用量追踪 |
| GET | `/api/ollama/status` | Ollama 运行状态（二进制、运行中、版本） |
| POST | `/api/ollama/setup` | 下载 Ollama + 启动服务（SSE 进度流） |
| POST | `/api/ollama/start` | 启动 Ollama 服务 |
| POST | `/api/ollama/stop` | 停止 Ollama 服务 |
| GET | `/api/ollama/models` | 列出本地已安装的 Ollama 模型 |
| GET | `/api/ollama/models/library` | 浏览模型库（搜索、排序、翻页） |
| POST | `/api/ollama/models/pull` | 下载模型（SSE 进度流） |
| DELETE | `/api/ollama/models/{name}` | 删除本地模型 |
| DELETE | `/api/ollama/uninstall` | 移除 Ollama 二进制 + 可选删除模型 |
| GET | `/api/rapid-mlx/status` | Rapid-MLX 运行状态（仅 macOS Apple Silicon） |
| POST | `/api/rapid-mlx/start` | 使用所选模型/端口启动 Rapid-MLX |
| POST | `/api/rapid-mlx/stop` | 停止 Rapid-MLX |
| POST | `/api/rapid-mlx/cached` | 检查精选 MLX alias 是否已下载 |
| POST | `/api/rapid-mlx/remove` | 从缓存中移除已下载的 Rapid-MLX 模型 |
| | **频道（OpenClaw）** | |
| GET | `/api/channels/openclaw/status` | OpenClaw 运行状态 |
| POST | `/api/channels/openclaw/setup` | 安装 OpenClaw 二进制（SSE 进度流） |
| POST | `/api/channels/login` | 开始频道登录（如 WhatsApp 二维码） |
| POST | `/api/channels/add` | 添加频道（token/凭据） |
| POST | `/api/channels/remove` | 移除频道 |
| GET | `/api/channels/list` | 列出已连接频道 |
| | **记忆** | |
| GET | `/api/memory` | 获取所有记忆（上下文 + 事实） |
| POST | `/api/memory/facts` | 添加新事实 |
| DELETE | `/api/memory/facts` | 按 ID 移除事实 |
| PUT | `/api/memory/context` | 更新上下文段落 |
| GET/PUT | `/api/memory/config` | 获取/更新记忆配置 |
| | **自动化任务** | |
| GET | `/api/automations/templates` | 列出内置自动化模板 |
| POST | `/api/automations/from-template` | 从模板创建自动化 |
| GET/POST | `/api/automations` | 列表 / 创建自动化 |
| GET/PATCH/DELETE | `/api/automations/{id}` | 查看 / 更新 / 删除自动化 |
| POST | `/api/automations/{id}/trigger` | 手动触发自动化 |
| | **连接器（MCP）** | |
| GET | `/api/connectors` | 列出所有连接器及状态 |
| GET | `/api/connectors/{id}` | 获取连接器详情 |
| POST | `/api/connectors/{id}/reconnect` | 重连连接器 |
| | **插件** | |
| GET | `/api/plugins` | 列出可用插件 |
| POST | `/api/plugins/{id}/enable` | 启用插件 |
| POST | `/api/plugins/{id}/disable` | 禁用插件 |

## 核心 Agent Loop

```
用户输入 → 创建 UserMessage → 构建 system prompt → 解析工具
    ↓
┌─ while True: ──────────────────────────────────────────┐
│  加载消息历史 → 调用 LLM 流式生成                        │
│    ├── text-delta → 发布 SSE + 保存 TextPart            │
│    ├── reasoning-delta → 发布 SSE + 保存 ReasoningPart  │
│    ├── tool-call → doom loop 检测 → 权限检查 → 执行工具   │
│    │     ├── 工具修复（大小写修正 → invalid 回退）         │
│    │     ├── 保存 ToolPart（input/output/state）         │
│    │     └── 如果是 task 工具 → 启动子 agent 循环         │
│    └── usage → 检查上下文溢出 → 触发两阶段压缩            │
│                                                         │
│  无工具调用 → break                                      │
│  有工具调用 → 继续循环（LLM 看到工具结果后决定下一步）      │
└────────────────────────────────────────────────────────┘
    ↓
首轮自动生成标题 → 发布 done 事件
```

## 权限系统

4 层层级权限引擎：

1. **全局** — 所有 agent 的基础规则
2. **Agent** — 每个 agent 的独立规则集
3. **用户** — 会话级覆盖
4. **会话** — 对话级特定规则

每个工具可设置为 `allow`（允许）、`deny`（拒绝）或 `ask`（在 UI 中询问用户）。

## LLM 提供者

21 个 BYOK 提供者 + Rapid-MLX/Ollama 本地 + ChatGPT 订阅：

| 提供者 | 类型 | 说明 |
|--------|------|------|
| OpenRouter | 聚合器 | 主要提供者，100+ 模型，支持 reasoning token |
| Rapid-MLX | 本地 | Apple Silicon MLX runtime，精选模型 alias，OpenAI-compatible API |
| Ollama | 本地 | 托管二进制生命周期，自动下载，启动预热 |
| ChatGPT 订阅 | OAuth | 接入现有 ChatGPT Plus/Team 订阅 |
| OpenAI | BYOK | 直接 API 密钥 |
| Anthropic | BYOK（原生 SDK） | 通过 Anthropic SDK 接入 Claude 模型 |
| Google Gemini | BYOK（原生 SDK） | 通过 Google GenAI SDK 接入 Gemini 模型 |
| Groq | BYOK | 快速推理 |
| DeepSeek | BYOK | DeepSeek V3/R1 |
| Mistral | BYOK | Mistral/Mixtral 模型 |
| xAI | BYOK | Grok 模型 |
| Together AI | BYOK | 开源模型托管 |
| DeepInfra | BYOK | |
| Cerebras | BYOK | 超快推理 |
| Cohere | BYOK | Command R+ |
| Perplexity | BYOK | 搜索增强模型 |
| Fireworks AI | BYOK | |
| Azure OpenAI | BYOK | 企业级 Azure 部署 |
| 通义千问（Qwen） | BYOK | 阿里巴巴 DashScope |
| Kimi（月之暗面） | BYOK | Moonshot |
| MiniMax | BYOK | |
| 智谱（ZhipuAI） | BYOK | GLM 模型 |
| 硅基流动（SiliconFlow） | BYOK | |
| Xiaomi MiMo | BYOK | |

所有 BYOK 提供者密钥遵循 `OPENYAK_{PROVIDER}_API_KEY` 格式。

## 使用示例

```bash
# 简单聊天
curl -X POST http://localhost:8000/api/chat/prompt \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello!", "model": "z-ai/glm-4.7-flash"}'
# 返回: {"stream_id": "...", "session_id": "..."}

# 订阅 SSE 流
curl -N http://localhost:8000/api/chat/stream/{stream_id}

# 工具调用（agent 自动调用 read/grep 等工具）
curl -X POST http://localhost:8000/api/chat/prompt \
  -H "Content-Type: application/json" \
  -d '{"text": "Read the file at ./app/main.py and explain what it does"}'

# 列出工具
curl http://localhost:8000/api/tools

# 列出 agent
curl http://localhost:8000/api/agents
```

## 技术栈

- **Python 3.12+** / FastAPI / Pydantic v2
- **SQLAlchemy** (async) + SQLite WAL
- **OpenAI SDK** → OpenRouter（支持 reasoning tokens）
- **Anthropic SDK** → 原生 Anthropic 提供者
- **Google GenAI SDK** → 原生 Gemini 提供者
- **MCP SDK** → Model Context Protocol 客户端（可选）
- **SSE** 可恢复流式传输
- **ULID** 主键
- **tiktoken** token 计数
- **PyInstaller** 独立打包

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OPENYAK_OPENROUTER_API_KEY` | OpenRouter API 密钥 | （可选） |
| `OPENYAK_DATABASE_URL` | 数据库连接字符串 | `sqlite+aiosqlite:///./data/openyak.db` |
| `OPENYAK_HOST` | 监听地址 | `0.0.0.0` |
| `OPENYAK_PORT` | 监听端口 | `8000` |
| `OPENYAK_DEBUG` | 调试模式 | `false` |
| `OPENYAK_PROJECT_DIR` | 工作区根目录（文件操作用） | `.` |
| `OPENYAK_COMPACTION_AUTO` | 自动上下文压缩 | `true` |
| `OPENYAK_DAILY_SEARCH_LIMIT` | 每日网页搜索配额 | `20` |
| `OPENYAK_FTS_ENABLED` | 全文搜索索引 | `true` |
| `OPENYAK_OLLAMA_BASE_URL` | Ollama 服务地址（setup 自动设置） | `` |
| `OPENYAK_OLLAMA_AUTO_START` | 启动时自动启动托管的 Ollama | `true` |
| `OPENYAK_OLLAMA_LAST_MODEL` | 上次使用的模型（用于启动预热） | `` |
| `OPENYAK_RAPID_MLX_BASE_URL` | Rapid-MLX OpenAI-compatible endpoint | `` |
| `OPENYAK_RAPID_MLX_MODEL` | 上次选择的 Rapid-MLX 模型 alias | `` |
| `OPENYAK_OPENCLAW_ENABLED` | 启用 OpenClaw IM 桥接 | `false` |
| `OPENYAK_OPENCLAW_URL` | OpenClaw WebSocket 地址 | `ws://127.0.0.1:18789` |
| `OPENYAK_PROXY_URL` | 托管工具代理地址（可选） | `` |
| `OPENYAK_PROXY_TOKEN` | 代理认证 JWT | `` |
| `OPENYAK_BRAVE_SEARCH_API_KEY` | Brave Search API 密钥（增强网页搜索） | `` |
| `OPENYAK_REMOTE_ACCESS_ENABLED` | 启用远程隧道访问 | `false` |

## 构建与部署

```bash
# 开发模式
uvicorn app.main:app --reload

# 桌面模式（独立入口）
python run.py --port 8100 --data-dir /path/to/app/data

# 生产构建（PyInstaller 打包）
pyinstaller openyak.spec
./dist/openyak
```
