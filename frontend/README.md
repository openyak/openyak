[中文](README.zh-CN.md)

# OpenYak Frontend

Next.js 15 frontend providing a professional-grade Chat UI for the OpenYak backend, inspired by LibreChat's UX architecture.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start dev server (requires backend running on localhost:8000)
npm run dev

# Or start both frontend and backend from the project root
cd .. && npm run dev:all
```

Open http://localhost:3000 in your browser.

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | Next.js (App Router + Turbopack) | 15 |
| Runtime | React | 19 |
| Language | TypeScript | 5.7 |
| Styling | Tailwind CSS | 4 |
| Components | shadcn/ui (Radix + Tailwind) | — |
| UI Components | MUI (Material UI) | 7 |
| Client State | Zustand | 5 |
| Server State | TanStack Query | 5 |
| Icons | Lucide React | — |
| Markdown | react-markdown + remark-gfm + rehype-highlight | — |
| Charts | Recharts | 3 |
| Diagrams | Mermaid | 11 |
| Document Preview | docx-preview, react-pdf, xlsx | — |
| Animation | Framer Motion | 12 |
| Command Palette | cmdk | — |
| Virtualization | TanStack Virtual | 3 |
| Theme | next-themes (dark/light/system) | — |
| Notifications | Sonner | — |
| i18n | i18next + react-i18next | — |
| Desktop | @tauri-apps/api | 2 |

## Architecture

```
src/
├── app/                          # Next.js App Router
│   ├── layout.tsx                #   Root layout (fonts, theme, provider nesting)
│   ├── page.tsx                  #   Redirect to /c/new
│   ├── globals.css               #   CSS variable color system + global styles
│   ├── (main)/                   #   Route group: main desktop shell
│   │   ├── layout.tsx            #     Sidebar + main content area layout
│   │   ├── c/new/page.tsx        #     New conversation (Landing page)
│   │   ├── c/[sessionId]/page.tsx #    Active conversation
│   │   ├── automations/page.tsx  #     Automation management
│   │   ├── plugins/page.tsx      #     Plugin management
│   │   ├── remote/page.tsx       #     Remote access (tunnel, QR, permissions)
│   │   └── settings/page.tsx     #     Settings (7 tabs: general, providers, memory, ollama, billing, usage)
│   └── (mobile)/                  #   Route group: mobile web UI
│       ├── layout.tsx
│       └── m/
│           ├── page.tsx           #     Mobile home
│           ├── new/page.tsx       #     Mobile new conversation
│           ├── settings/page.tsx  #     Mobile settings
│           └── task/[id]/page.tsx #     Mobile task view
│
├── components/
│   ├── providers/                # Provider layer
│   │   ├── theme-provider.tsx    #   next-themes dark/light
│   │   ├── query-provider.tsx    #   TanStack Query
│   │   └── app-providers.tsx     #   Compose all providers
│   │
│   ├── layout/                   # Layout components
│   │   ├── sidebar.tsx           #   Desktop sidebar (fixed 260px)
│   │   ├── sidebar-header.tsx    #   Logo + new chat button
│   │   ├── sidebar-nav.tsx       #   Nav items (Automations, Plugins, Remote, Settings)
│   │   ├── session-list.tsx      #   Session list (with search filter)
│   │   ├── session-item.tsx      #   Single session (highlight, delete, timestamp)
│   │   ├── sidebar-footer.tsx    #   User info + settings gear
│   │   └── mobile-nav.tsx        #   Mobile drawer navigation (Sheet)
│   │
│   ├── settings/                 # Settings components (7 tabs)
│   │   ├── settings-layout.tsx   #   Tab layout
│   │   ├── general-tab.tsx       #   General settings (appearance, language)
│   │   ├── providers-tab.tsx     #   BYOK provider key management
│   │   ├── memory-tab.tsx        #   Memory settings & fact management
│   │   ├── ollama-panel.tsx      #   Ollama management (setup, models, library, pull/delete)
│   │   ├── billing-tab.tsx       #   Billing & subscription
│   │   └── usage-tab.tsx         #   Token usage statistics
│   │
│   ├── activity/                 # Activity tracking
│   │   ├── activity-panel.tsx    #   Activity side panel
│   │   ├── activity-summary.tsx  #   Activity summary card
│   │   ├── activity-thinking.tsx #   Thinking indicator
│   │   └── activity-timeline.tsx #   Activity timeline
│   │
│   ├── artifacts/                # Artifact rendering system
│   │   ├── artifact-panel.tsx    #   Artifact viewer panel
│   │   └── renderers/            #   13 specialized renderers (code, html, markdown, mermaid,
│   │                             #   svg, react, csv, xlsx, pdf, docx, pptx, file-preview)
│   │
│   ├── billing/                  # Billing & upgrade prompts
│   ├── desktop/                  # Desktop-specific (native title bar)
│   ├── icons/                    # Platform icons (IM channel icons)
│   ├── mobile/                   # Mobile-specific components
│   ├── onboarding/               # First-run onboarding screen
│   ├── plan-review/              # Plan review panel
│   ├── workspace/                # Workspace panel
│   │   ├── workspace-panel.tsx   #   Main workspace panel
│   │   ├── context-section.tsx   #   Context tracking
│   │   ├── files-section.tsx     #   File tracking
│   │   └── progress-section.tsx  #   Progress tracking
│   │
│   ├── chat/                     # Chat interface
│   │   ├── chat-view.tsx         #   Conversation orchestrator (messages + input + interactive prompts)
│   │   ├── chat-header.tsx       #   Session title + model badge
│   │   ├── chat-form.tsx         #   Input box (auto-expand + Agent/Model tags)
│   │   ├── chat-textarea.tsx     #   Auto-resizing textarea
│   │   ├── chat-actions.tsx      #   Send/Stop buttons
│   │   ├── landing.tsx           #   New conversation landing (Hero + conversation starters)
│   │   └── chat-footer.tsx       #   Footer disclaimer
│   │
│   ├── messages/                 # Message rendering
│   │   ├── message-list.tsx      #   Message list (auto-scroll to bottom)
│   │   ├── message-item.tsx      #   Single message container (routes to user/assistant)
│   │   ├── message-avatar.tsx    #   User/assistant avatar
│   │   ├── message-content.tsx   #   Content dispatcher (routes by part.type)
│   │   ├── user-message.tsx      #   User message
│   │   └── assistant-message.tsx #   Assistant message + streaming message (typing indicator)
│   │
│   ├── parts/                    # Message part renderers
│   │   ├── text-part.tsx         #   Markdown rendering (code blocks with copy button)
│   │   ├── reasoning-part.tsx    #   Collapsible reasoning trace
│   │   ├── tool-part.tsx         #   Tool call visualization (icon, status, duration, expandable I/O)
│   │   ├── step-indicator.tsx    #   Step marker (token usage, cost)
│   │   ├── compaction-part.tsx   #   Context compression notification
│   │   └── subtask-part.tsx      #   Subtask link
│   │
│   ├── interactive/              # Blocking interactive prompts
│   │   ├── permission-dialog.tsx #   Permission request (inline Allow/Deny card)
│   │   └── question-prompt.tsx   #   Question prompt (option buttons + free text input)
│   │
│   ├── selectors/                # Selectors
│   │   ├── model-selector.tsx    #   Model dropdown
│   │   ├── agent-selector.tsx    #   Agent selector (build/plan/explore)
│   │   └── model-badge.tsx       #   Current model tag
│   │
│   └── ui/                       # shadcn/ui base components
│       └── button, dialog, sheet, scroll-area, select, tooltip,
│           skeleton, separator, badge, avatar, collapsible,
│           dropdown-menu, input, popover
│
├── hooks/                        # Custom hooks (28)
│   ├── use-chat.ts               #   Core chat hook (prompt → stream → assemble)
│   ├── use-sse.ts                #   SSE connection + event dispatch to chatStore
│   ├── use-sessions.ts           #   TanStack Query: session CRUD
│   ├── use-messages.ts           #   TanStack Query: message fetching
│   ├── use-models.ts             #   TanStack Query: model list
│   ├── use-agents.ts             #   TanStack Query: agent list
│   ├── use-auto-resize.ts        #   Textarea auto-height
│   ├── use-scroll-anchor.ts      #   Auto-scroll to bottom
│   ├── use-mobile.ts             #   Mobile breakpoint detection
│   ├── use-channels.ts           #   OpenClaw channel management
│   ├── use-automations.ts        #   Automation CRUD
│   ├── use-connectors.ts         #   MCP connector management
│   ├── use-mcp.ts                #   MCP server status
│   ├── use-plugins.ts            #   Plugin management
│   ├── use-provider-models.ts    #   BYOK provider model lists
│   ├── use-auto-detect-provider.ts # Auto-detect available providers
│   ├── use-usage.ts              #   Usage statistics
│   ├── use-mermaid.ts            #   Mermaid diagram rendering
│   ├── use-arena-scores.ts       #   Model arena scores
│   ├── use-active-session-id.ts  #   Active session tracking
│   ├── use-keyboard-shortcuts.ts #   Global keyboard shortcuts
│   ├── use-debounced-prefetch.ts #   Debounced data prefetching
│   ├── use-index-status.ts       #   FTS index status
│   ├── use-message-stats.ts      #   Message statistics
│   ├── use-session-export.ts     #   Session export (PDF/Markdown)
│   ├── use-remote-generation-sync.ts # Remote generation sync
│   └── use-remote-health.ts      #   Remote tunnel health check
│
├── stores/                       # Zustand state management (10 stores)
│   ├── chat-store.ts             #   Streaming generation state (real-time parts assembly)
│   ├── sidebar-store.ts          #   Sidebar visibility + search
│   ├── settings-store.ts         #   User preferences (model, agent, persisted to localStorage)
│   ├── activity-store.ts         #   Activity panel state
│   ├── artifact-store.ts         #   Artifact panel state
│   ├── auth-store.ts             #   Authentication state
│   ├── billing-store.ts          #   Billing/subscription state
│   ├── connection-store.ts       #   IM connection state
│   ├── plan-review-store.ts      #   Plan review state
│   └── workspace-store.ts        #   Workspace panel state
│
├── lib/                          # Utilities (12 modules)
│   ├── api.ts                    #   Typed fetch wrapper (type-safe, error handling)
│   ├── sse.ts                    #   SSE client (reconnection, heartbeat timeout)
│   ├── utils.ts                  #   cn(), formatRelativeTime(), truncate()
│   ├── constants.ts              #   API route constants, query key factory
│   ├── routes.ts                 #   Route definitions
│   ├── artifacts.ts              #   Artifact utilities
│   ├── pricing.ts                #   Model pricing calculations
│   ├── proxy-api.ts              #   Cloud proxy API client
│   ├── remote-connection.ts      #   Remote tunnel connection
│   ├── sources.ts                #   Data source utilities
│   ├── tauri-api.ts              #   Tauri desktop API bridge
│   └── upload.ts                 #   File upload utilities
│
├── types/                        # TypeScript types (16 modules, mirrors backend schemas)
│   ├── session.ts                #   SessionResponse, SessionCreate
│   ├── message.ts                #   MessageResponse, PartData union type
│   ├── chat.ts                   #   PromptRequest, PromptResponse
│   ├── streaming.ts              #   SSE event types, PermissionRequest, QuestionRequest
│   ├── agent.ts                  #   AgentInfo, PermissionRule
│   ├── model.ts                  #   ModelInfo, ModelCapabilities
│   ├── artifact.ts               #   Artifact types
│   ├── automation.ts             #   Automation/scheduled task types
│   ├── channels.ts               #   IM channel types
│   ├── connectors.ts             #   MCP connector types
│   ├── mcp.ts                    #   MCP server types
│   ├── memory.ts                 #   Memory fact/context types
│   ├── plugins.ts                #   Plugin types
│   ├── usage.ts                  #   Usage tracking types
│   └── index.ts                  #   Barrel export
│
└── i18n/                         # Internationalization
    └── locales/{lang}/{ns}.json  #   Translation files (en, zh)
```

## Layout Design

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
│ │Search │ │  │   ├── AssistantMessage               │    │
│ │Autom. │ │  │   │   ├── TextPart (markdown)        │    │
│ │Plugin │ │  │   │   ├── ReasoningPart (collapsible) │   │
│ │Models │ │  │   │   ├── ToolPart (expandable)      │    │
│ │Remote │ │  │   │   └── StepIndicator              │    │
│ │Usage  │ │  │   └── StreamingMessage (typing)      │    │
│ ├───────┤ │  ├──────────────────────────────────────┤    │
│ │Session│ │  │ PermissionDialog / QuestionPrompt    │    │
│ │List   │ │  ├──────────────────────────────────────┤    │
│ │       │ │  │ ChatForm                             │    │
│ ├───────┤ │  │ ┌────────────────────────────┬─────┐ │    │
│ │User ⚙│ │  │ │ Textarea (auto-resize)     │Send │ │    │
│ └───────┘ │  │ └────────────────────────────┴─────┘ │    │
│           │  │ [agent badge] [model badge]          │    │
│           │  └──────────────────────────────────────┘    │
├───────────┴──────────────────────────────────────────────┤
│  MobileNav (≤768px, Sheet drawer)                        │
└──────────────────────────────────────────────────────────┘
```

## State Management

```
┌──────────────────────────────────────────┐
│          TanStack Query v5               │
│     Server state (cache + sync)          │
│  sessions, messages, models, agents,     │
│  channels, memory, automations, plugins  │
├──────────────────────────────────────────┤
│         Zustand (10 stores)              │
│         Client state (reactive)          │
│  chatStore: streaming state, parts       │
│  sidebarStore: sidebar toggle, search    │
│  settingsStore: model, agent prefs       │
│  activityStore: activity panel state     │
│  artifactStore: artifact panel state     │
│  authStore: authentication state         │
│  billingStore: billing/subscription      │
│  connectionStore: IM connection state    │
│  planReviewStore: plan review state      │
│  workspaceStore: workspace panel state   │
├──────────────────────────────────────────┤
│           next-themes                    │
│       Theme state (dark/light/system)    │
└──────────────────────────────────────────┘
```

## SSE Streaming Data Flow

```
User sends message
       │
       ▼
POST /api/chat/prompt { text, session_id?, model, agent }
       │
       ▼
Returns { stream_id, session_id }
       │
       ├─► chatStore.startGeneration()
       ▼
EventSource → /api/chat/stream/{stream_id}
       │
       ▼  SSE event dispatch
  ┌────────────────────────────────────────────────┐
  │ text_delta       → chatStore.appendTextDelta() │
  │ reasoning_delta  → chatStore.appendReasoning() │
  │ tool_start       → chatStore.addToolStart()    │
  │ tool_result      → chatStore.setToolResult()   │
  │ tool_error       → chatStore.setToolError()    │
  │ step_start/finish → chatStore.addStep*()       │
  │ permission_request → show PermissionDialog     │
  │ question          → show QuestionPrompt        │
  │ done → finishGeneration() + invalidate queries │
  │ error → toast.error() + finish                 │
  └────────────────────────────────────────────────┘
```

## Design System

Tokens, theme rules, motion, AI-native UI patterns, responsive breakpoints, and a11y rules: see [`DESIGN.md`](../DESIGN.md) at the repo root.

## Key Components

### MessageContent (Content Dispatcher)

Routes message parts to their corresponding renderer by `PartData.type`:

| Part Type | Renderer | Description |
|-----------|----------|-------------|
| `text` | TextPart | Markdown rendering, code blocks with copy button + language label |
| `reasoning` | ReasoningPart | Collapsible reasoning trace, expanded while streaming, collapsed on completion |
| `tool` | ToolPartView | Tool call card showing icon, status, duration; expandable input/output |
| `step-start` | StepIndicator | Step start divider |
| `step-finish` | StepIndicator | Step completion, shows token usage and cost |
| `compaction` | CompactionPart | Context compression notification |
| `subtask` | SubtaskPart | Subtask link, click to navigate to child session |

### ToolPartView (Tool Call Visualization)

12 tool types with dedicated icons, 4 states (pending/running/completed/error) with distinct colors and animations:

| Tool | Icon |
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

### Interactive Prompts

- **PermissionDialog**: Inline card with Allow/Deny buttons, responds via `POST /api/chat/respond`
- **QuestionPrompt**: Inline card with option buttons + free text input

### ArtifactPanel (Rich Content Rendering)

13 specialized renderers for rich artifact content:

| Renderer | Content |
|----------|---------|
| code | Syntax-highlighted code with copy |
| html | Sandboxed HTML preview |
| markdown | Markdown rendering |
| mermaid | Diagram rendering (flowcharts, sequence, etc.) |
| svg | SVG graphics preview |
| react | Live React component preview |
| csv | CSV table rendering (PapaParse) |
| xlsx | Excel spreadsheet preview |
| pdf | PDF document preview (react-pdf) |
| docx | Word document preview (docx-preview) |
| pptx | PowerPoint preview |
| file-preview | Generic file preview |

### WorkspacePanel

Collapsible side panel showing real-time workspace state:
- **Context section** — Active context and file references
- **Files section** — Files read/written during conversation
- **Progress section** — Task progress tracking

### ActivityPanel

Real-time activity tracking with timeline, thinking indicators, and summary cards for session activity.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NEXT_PUBLIC_API_URL` | Backend API address | `http://localhost:8000` |

## Scripts

```bash
npm run dev       # Dev server (Turbopack, port 3000)
npm run build     # Production build
npm run start     # Production mode
npm run lint      # ESLint check
```
