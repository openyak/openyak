[English](README.md)

# OpenYak 前端

Next.js 15 前端，为 OpenYak 后端提供专业级 Chat UI，参考 LibreChat 的 UX 架构设计。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动开发服务器（需要后端运行在 localhost:8000）
npm run dev

# 或者从项目根目录一键启动前后端
cd .. && npm run dev:all
```

启动后访问：http://localhost:3000

## 技术栈

| 层 | 技术 | 版本 |
|---|------|------|
| 框架 | Next.js (App Router + Turbopack) | 15 |
| 运行时 | React | 19 |
| 语言 | TypeScript | 5.7 |
| 样式 | Tailwind CSS | 4 |
| 组件库 | shadcn/ui (Radix + Tailwind) | — |
| UI 组件 | MUI (Material UI) | 7 |
| 客户端状态 | Zustand | 5 |
| 服务端状态 | TanStack Query | 5 |
| 图标 | Lucide React | — |
| Markdown | react-markdown + remark-gfm + rehype-highlight | — |
| 图表 | Recharts | 3 |
| 流程图 | Mermaid | 11 |
| 文档预览 | docx-preview, react-pdf, xlsx | — |
| 动画 | Framer Motion | 12 |
| 命令面板 | cmdk | — |
| 虚拟化 | TanStack Virtual | 3 |
| 主题 | next-themes (dark/light/system) | — |
| 通知 | Sonner | — |
| 国际化 | i18next + react-i18next | — |
| 桌面端 | @tauri-apps/api | 2 |

## 架构

```
src/
├── app/                          # Next.js App Router
│   ├── layout.tsx                #   根布局（字体、主题、Provider 嵌套）
│   ├── page.tsx                  #   重定向到 /c/new
│   ├── globals.css               #   CSS 变量色彩系统 + 全局样式
│   ├── (main)/                   #   路由组：主桌面壳
│   │   ├── layout.tsx            #     侧边栏 + 主内容区布局
│   │   ├── c/new/page.tsx        #     新对话（Landing 页）
│   │   ├── c/[sessionId]/page.tsx #    活跃对话
│   │   ├── automations/page.tsx  #     自动化任务管理
│   │   ├── plugins/page.tsx      #     插件管理
│   │   ├── remote/page.tsx       #     远程访问（隧道、二维码、权限）
│   │   └── settings/page.tsx     #     设置（通用、服务商、权限、自动化、插件、远程、用量、记忆）
│   └── (mobile)/                  #   路由组：移动端 Web UI
│       ├── layout.tsx
│       └── m/
│           ├── page.tsx           #     移动端首页
│           ├── new/page.tsx       #     移动端新对话
│           ├── settings/page.tsx  #     移动端设置
│           └── task/[id]/page.tsx #     移动端任务视图
│
├── components/
│   ├── providers/                # Provider 层
│   │   ├── theme-provider.tsx    #   next-themes 暗色/亮色
│   │   ├── query-provider.tsx    #   TanStack Query
│   │   └── app-providers.tsx     #   组合所有 Provider
│   │
│   ├── layout/                   # 布局组件
│   │   ├── sidebar.tsx           #   桌面端侧边栏（固定 260px）
│   │   ├── sidebar-header.tsx    #   Logo + 新建对话按钮
│   │   ├── sidebar-nav.tsx       #   导航项（自动化、插件、远程、设置）
│   │   ├── session-list.tsx      #   会话列表（带搜索过滤）
│   │   ├── session-item.tsx      #   单条会话（高亮、删除、时间戳）
│   │   ├── sidebar-footer.tsx    #   用户信息 + 设置齿轮
│   │   └── mobile-nav.tsx        #   移动端抽屉导航（Sheet）
│   │
│   ├── settings/                 # 设置组件
│   │   ├── settings-layout.tsx   #   标签布局
│   │   ├── general-tab.tsx       #   通用设置（外观、语言）
│   │   ├── providers-tab.tsx     #   Provider 选择和 BYOK 提供商密钥管理
│   │   ├── memory-tab.tsx        #   记忆设置 & 事实管理
│   │   ├── ollama-panel.tsx      #   Ollama 管理（安装、模型库、下载/删除）
│   │   ├── rapid-mlx-panel.tsx   #   Rapid-MLX 管理（启动/停止/切换/删除）
│   │   └── usage-tab.tsx         #   Token 用量统计
│   │
│   ├── activity/                 # 活动追踪
│   │   ├── activity-panel.tsx    #   活动侧面板
│   │   ├── activity-summary.tsx  #   活动摘要卡片
│   │   ├── activity-thinking.tsx #   思考指示器
│   │   └── activity-timeline.tsx #   活动时间线
│   │
│   ├── artifacts/                # Artifact 渲染系统
│   │   ├── artifact-panel.tsx    #   Artifact 查看面板
│   │   └── renderers/            #   13 个专用渲染器（code, html, markdown, mermaid,
│   │                             #   svg, react, csv, xlsx, pdf, docx, pptx, file-preview）
│   │
│   ├── desktop/                  # 桌面端专用（原生标题栏）
│   ├── icons/                    # 平台图标（IM 频道图标）
│   ├── mobile/                   # 移动端专用组件
│   ├── onboarding/               # 首次使用引导界面
│   ├── plan-review/              # 计划审查面板
│   ├── workspace/                # 工作区面板
│   │   ├── workspace-panel.tsx   #   主工作区面板
│   │   ├── context-section.tsx   #   上下文追踪
│   │   ├── files-section.tsx     #   文件追踪
│   │   └── progress-section.tsx  #   进度追踪
│   │
│   ├── chat/                     # 聊天界面
│   │   ├── chat-view.tsx         #   对话页编排器（消息 + 输入 + 交互提示）
│   │   ├── chat-header.tsx       #   会话标题 + Model badge
│   │   ├── chat-form.tsx         #   输入框（自动扩展 + Agent/Model 标签）
│   │   ├── chat-textarea.tsx     #   自动调整高度的 textarea
│   │   ├── chat-actions.tsx      #   发送/停止按钮
│   │   ├── landing.tsx           #   新对话 Landing（Hero + 对话启动器）
│   │   └── chat-footer.tsx       #   底部声明
│   │
│   ├── messages/                 # 消息渲染
│   │   ├── message-list.tsx      #   消息列表（自动滚动到底部）
│   │   ├── message-item.tsx      #   单条消息容器（路由到 user/assistant）
│   │   ├── message-avatar.tsx    #   用户/助手头像
│   │   ├── message-content.tsx   #   内容分发器（按 part.type 路由）
│   │   ├── user-message.tsx      #   用户消息
│   │   └── assistant-message.tsx #   助手消息 + 流式消息（打字指示器）
│   │
│   ├── parts/                    # 消息部件渲染器
│   │   ├── text-part.tsx         #   Markdown 渲染（代码块带复制按钮）
│   │   ├── reasoning-part.tsx    #   可折叠推理过程
│   │   ├── tool-part.tsx         #   工具调用可视化（图标、状态、耗时、展开输入/输出）
│   │   ├── step-indicator.tsx    #   步骤标记（token 用量、费用）
│   │   ├── compaction-part.tsx   #   上下文压缩通知
│   │   └── subtask-part.tsx      #   子任务链接
│   │
│   ├── interactive/              # 交互式阻塞提示
│   │   ├── permission-dialog.tsx #   权限请求（Allow/Deny 内联卡片）
│   │   └── question-prompt.tsx   #   问题提示（选项按钮 + 自由输入）
│   │
│   ├── selectors/                # 选择器
│   │   ├── model-selector.tsx    #   模型下拉选择
│   │   ├── agent-selector.tsx    #   Agent 选择（build/plan/explore）
│   │   └── model-badge.tsx       #   当前模型标签
│   │
│   └── ui/                       # shadcn/ui 基础组件
│       └── button, dialog, sheet, scroll-area, select, tooltip,
│           skeleton, separator, badge, avatar, collapsible,
│           dropdown-menu, input, popover
│
├── hooks/                        # 自定义 Hooks（28 个）
│   ├── use-chat.ts               #   核心聊天 Hook（prompt → stream → 组装）
│   ├── use-sse.ts                #   SSE 连接 + 事件分发到 chatStore
│   ├── use-sessions.ts           #   TanStack Query: 会话 CRUD
│   ├── use-messages.ts           #   TanStack Query: 消息获取
│   ├── use-models.ts             #   TanStack Query: 模型列表
│   ├── use-agents.ts             #   TanStack Query: Agent 列表
│   ├── use-auto-resize.ts        #   Textarea 自动调整高度
│   ├── use-scroll-anchor.ts      #   自动滚动到底部
│   ├── use-mobile.ts             #   移动端断点检测
│   ├── use-channels.ts           #   OpenClaw 频道管理
│   ├── use-automations.ts        #   自动化任务 CRUD
│   ├── use-connectors.ts         #   MCP 连接器管理
│   ├── use-mcp.ts                #   MCP 服务器状态
│   ├── use-plugins.ts            #   插件管理
│   ├── use-provider-models.ts    #   BYOK 提供商模型列表
│   ├── use-auto-detect-provider.ts # 自动检测可用提供商
│   ├── use-usage.ts              #   用量统计
│   ├── use-mermaid.ts            #   Mermaid 流程图渲染
│   ├── use-arena-scores.ts       #   模型竞技场评分
│   ├── use-active-session-id.ts  #   活跃会话追踪
│   ├── use-keyboard-shortcuts.ts #   全局快捷键
│   ├── use-debounced-prefetch.ts #   防抖数据预取
│   ├── use-index-status.ts       #   FTS 索引状态
│   ├── use-message-stats.ts      #   消息统计
│   ├── use-session-export.ts     #   会话导出（PDF/Markdown）
│   ├── use-remote-generation-sync.ts # 远程生成同步
│   └── use-remote-health.ts      #   远程隧道健康检查
│
├── stores/                       # Zustand 状态管理（8 个 Store）
│   ├── chat-store.ts             #   流式生成状态（streaming parts 实时组装）
│   ├── sidebar-store.ts          #   侧边栏可见性 + 搜索
│   ├── settings-store.ts         #   用户偏好（model、agent，localStorage 持久化）
│   ├── activity-store.ts         #   活动面板状态
│   ├── artifact-store.ts         #   Artifact 面板状态
│   ├── connection-store.ts       #   IM 连接状态
│   ├── plan-review-store.ts      #   计划审查状态
│   └── workspace-store.ts        #   工作区面板状态
│
├── lib/                          # 工具库（11 个模块）
│   ├── api.ts                    #   Fetch 封装（类型安全、错误处理）
│   ├── sse.ts                    #   SSE 客户端（断线重连、心跳超时检测）
│   ├── utils.ts                  #   cn()、formatRelativeTime()、truncate()
│   ├── constants.ts              #   API 路由常量、Query Key 工厂
│   ├── routes.ts                 #   路由定义
│   ├── artifacts.ts              #   Artifact 工具函数
│   ├── pricing.ts                #   模型定价计算
│   ├── remote-connection.ts      #   远程隧道连接
│   ├── sources.ts                #   数据源工具函数
│   ├── tauri-api.ts              #   Tauri 桌面端 API 桥接
│   └── upload.ts                 #   文件上传工具函数
│
├── types/                        # TypeScript 类型（16 个模块，镜像后端 schemas）
│   ├── session.ts                #   SessionResponse, SessionCreate
│   ├── message.ts                #   MessageResponse, PartData 联合类型
│   ├── chat.ts                   #   PromptRequest, PromptResponse
│   ├── streaming.ts              #   SSE 事件类型, PermissionRequest, QuestionRequest
│   ├── agent.ts                  #   AgentInfo, PermissionRule
│   ├── model.ts                  #   ModelInfo, ModelCapabilities
│   ├── artifact.ts               #   Artifact 类型
│   ├── automation.ts             #   自动化/定时任务类型
│   ├── channels.ts               #   IM 频道类型
│   ├── connectors.ts             #   MCP 连接器类型
│   ├── mcp.ts                    #   MCP 服务器类型
│   ├── memory.ts                 #   记忆事实/上下文类型
│   ├── plugins.ts                #   插件类型
│   ├── usage.ts                  #   用量追踪类型
│   └── index.ts                  #   Barrel 导出
│
└── i18n/                         # 国际化
    └── locales/{lang}/{ns}.json  #   翻译文件（en, zh）
```

## 布局设计

```
┌──────────────────────────────────────────────────────────┐
│                    Root Layout                           │
│  ThemeProvider → QueryProvider → Toaster → children      │
├───────────┬──────────────────────────────────────────────┤
│           │                                              │
│  Sidebar  │           Main Content                       │
│  260px    │                                              │
│  fixed    │  ┌──────────────────────────────────────┐    │
│           │  │ ChatHeader (title, model badge)      │    │
│ ┌───────┐ │  ├──────────────────────────────────────┤    │
│ │ Logo  │ │  │                                      │    │
│ │+ New  │ │  │ MessageList                          │    │
│ ├───────┤ │  │   ├── UserMessage                    │    │
│ │搜索   │ │  │   ├── AssistantMessage               │    │
│ │自动化 │ │  │   │   ├── TextPart (markdown)        │    │
│ │插件   │ │  │   │   ├── ReasoningPart (折叠)       │    │
│ │模型   │ │  │   │   ├── ToolPart (可展开)          │    │
│ │远程   │ │  │   │   └── StepIndicator              │    │
│ │用量   │ │  │   └── StreamingMessage (打字指示器)   │    │
│ ├───────┤ │  ├──────────────────────────────────────┤    │
│ │会话   │ │  │ PermissionDialog / QuestionPrompt    │    │
│ │列表   │ │  ├──────────────────────────────────────┤    │
│ │       │ │  │ ChatForm                             │    │
│ ├───────┤ │  │ ┌────────────────────────────┬─────┐ │    │
│ │用户 ⚙│ │  │ │ Textarea (auto-resize)     │Send │ │    │
│ └───────┘ │  │ └────────────────────────────┴─────┘ │    │
│           │  │ [agent badge] [model badge]          │    │
│           │  └──────────────────────────────────────┘    │
├───────────┴──────────────────────────────────────────────┤
│  MobileNav (≤768px, Sheet 抽屉)                          │
└──────────────────────────────────────────────────────────┘
```

## 状态管理

```
┌──────────────────────────────────────────┐
│          TanStack Query v5               │
│     服务端状态（缓存 + 同步）              │
│  sessions, messages, models, agents,     │
│  channels, memory, automations, plugins  │
├──────────────────────────────────────────┤
│         Zustand（10 个 Store）            │
│        客户端状态（响应式）                │
│  chatStore: 流式生成状态、streaming parts │
│  sidebarStore: 侧边栏开关、搜索           │
│  settingsStore: model、agent 偏好        │
│  activityStore: 活动面板状态              │
│  artifactStore: Artifact 面板状态        │
│  connectionStore: IM 连接状态            │
│  planReviewStore: 计划审查状态            │
│  workspaceStore: 工作区面板状态           │
├──────────────────────────────────────────┤
│           next-themes                    │
│       主题状态 (dark/light/system)        │
└──────────────────────────────────────────┘
```

## SSE 流式数据流

```
用户发送消息
       │
       ▼
POST /api/chat/prompt { text, session_id?, model, agent }
       │
       ▼
返回 { stream_id, session_id }
       │
       ├─► chatStore.startGeneration()
       ▼
EventSource → /api/chat/stream/{stream_id}
       │
       ▼  SSE 事件分发
  ┌────────────────────────────────────────────────┐
  │ text_delta       → chatStore.appendTextDelta() │
  │ reasoning_delta  → chatStore.appendReasoning() │
  │ tool_start       → chatStore.addToolStart()    │
  │ tool_result      → chatStore.setToolResult()   │
  │ tool_error       → chatStore.setToolError()    │
  │ step_start/finish → chatStore.addStep*()       │
  │ permission_request → 显示 PermissionDialog     │
  │ question          → 显示 QuestionPrompt        │
  │ done → finishGeneration() + invalidate queries │
  │ error → toast.error() + finish                 │
  └────────────────────────────────────────────────┘
```

## 响应式设计

| 断点 | 行为 |
|------|------|
| `≥1024px` (lg) | 侧边栏固定显示，主区域 `ml-[260px]` |
| `768-1023px` (md) | 侧边栏可收起 |
| `<768px` (sm) | 侧边栏隐藏，Sheet 抽屉模式 |

## 主题系统

基于 CSS 变量的纯单色 + Indigo 色彩系统，支持暗色/亮色/跟随系统三种模式：

- **Surface**: primary / secondary / tertiary / chat 四级背景
- **Text**: primary / secondary / tertiary 三级文字
- **Border**: default / heavy 两级边框
- **Brand**: primary 品牌色
- **Semantic**: success / warning / destructive 语义色
- **Tool**: pending / running / completed / error 工具状态色

## 关键组件说明

### MessageContent（内容分发器）

按 `PartData.type` 将消息分发到对应渲染器：

| Part Type | 渲染器 | 说明 |
|-----------|--------|------|
| `text` | TextPart | Markdown 渲染，代码块带复制按钮 + 语言标签 |
| `reasoning` | ReasoningPart | 可折叠推理过程，流式时展开，完成后折叠 |
| `tool` | ToolPartView | 工具调用卡片，显示工具图标、状态、耗时，展开查看输入/输出 |
| `step-start` | StepIndicator | 步骤开始分隔线 |
| `step-finish` | StepIndicator | 步骤完成，显示 token 用量和费用 |
| `compaction` | CompactionPart | 上下文压缩通知 |
| `subtask` | SubtaskPart | 子任务链接，点击跳转到子 session |

### ToolPartView（工具调用可视化）

12 种工具各有专属图标，4 种状态（pending/running/completed/error）各有颜色和动画：

| 工具 | 图标 |
|------|------|
| read / write | FileText |
| edit | Pencil |
| bash | Terminal |
| glob | FolderSearch |
| grep | Search |
| web_fetch / web_search | Globe |
| task | GitBranch |
| question | HelpCircle |
| todo | ListTodo |
| memory | Brain |

### 交互式提示

- **PermissionDialog**: 内联卡片，Allow/Deny 按钮，通过 `POST /api/chat/respond` 回复
- **QuestionPrompt**: 内联卡片，支持选项按钮 + 自由文本输入

### ArtifactPanel（富内容渲染）

13 个专用渲染器用于富 Artifact 内容：

| 渲染器 | 内容 |
|--------|------|
| code | 语法高亮代码 + 复制按钮 |
| html | 沙箱 HTML 预览 |
| markdown | Markdown 渲染 |
| mermaid | 流程图渲染（流程图、时序图等） |
| svg | SVG 图形预览 |
| react | 实时 React 组件预览 |
| csv | CSV 表格渲染（PapaParse） |
| xlsx | Excel 电子表格预览 |
| pdf | PDF 文档预览（react-pdf） |
| docx | Word 文档预览（docx-preview） |
| pptx | PowerPoint 预览 |
| file-preview | 通用文件预览 |

### WorkspacePanel（工作区面板）

可折叠侧面板，实时展示工作区状态：
- **上下文段** — 活跃上下文和文件引用
- **文件段** — 对话中读写的文件
- **进度段** — 任务进度追踪

### ActivityPanel（活动面板）

实时活动追踪，包含时间线、思考指示器和会话活动摘要卡片。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `NEXT_PUBLIC_API_URL` | 后端 API 地址 | `http://localhost:8000` |

## 脚本

```bash
npm run dev       # 开发服务器（Turbopack，端口 3000）
npm run build     # 生产构建
npm run start     # 生产模式启动
npm run lint      # ESLint 检查
```
