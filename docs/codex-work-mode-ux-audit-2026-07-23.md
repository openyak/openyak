# OpenYak × Codex Work Mode UX 审计

日期：2026-07-23
范围：桌面端父任务、Composer、Workspace Summary、Subagents 列表与子 Agent 详情
基准：本机 `/Applications/ChatGPT.app`（bundle id `com.openai.codex`，版本 `26.715.72359`，build `5718`）

## 结论

OpenYak 已经把 Subagents 的视觉骨架做到了接近 Codex，但整体仍属于“组件相似”，还不是同构的 Work Mode 体验。

差距主要不在颜色、头像或圆角，而在四条任务连续性契约：

1. 父任务、执行过程、子 Agent 和产出必须属于同一个任务壳。
2. Workspace 与执行状态必须按父任务隔离，不能被其他并发会话覆盖。
3. Agent activity 应以可折叠的任务时间线呈现，完成后让位于最终答复，而不是长期占据主内容区。
4. Outputs、Subagents、Sources、Inputs 应来自同一份任务级 Summary 数据，并能追溯到对应结果。

因此，“完全对齐”不应理解为复制 Codex 的皮肤，而应优先对齐它的信息架构、状态归属、渐进披露和恢复路径。头像、Mac 窗口装饰、专有图标和细微动画不在本次对齐目标内。

## 证据

- 用户提供的 Codex Work Mode 完成态截图。
- OpenYak 在同一桌面视口（1936 × 1192）下的新鲜运行态截图。
- 本机 Codex 安装包 `app.asar` 的只读组件与状态文案核对。
- OpenYak 当前源码只读审计。
- OpenYak 父任务、Workspace、Subagents 列表与详情页运行时未出现浏览器 warning/error。

对照总览：

![Codex 与 OpenYak 总览对照](/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/06-codex-openyak-overview-comparison.png)

Subagents 列表对照：

![Codex 与 OpenYak Subagents 对照](/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/07-codex-openyak-subagents-comparison.png)

## 关键流程审计

### 1. Codex 父任务 Work Mode

健康度：良好。

- 左侧任务导航、中间主线程、右侧任务 Summary 形成稳定的三栏结构。
- 中间区域仍以最终答复和任务叙事为主；执行过程由 `Working / Worked for / You stopped after` 生命周期条目承接，并可折叠。
- 右侧 Summary 是同一任务的结构化索引，常见完成态自然收敛为 `Outputs → Subagents → Sources`。
- 产物同时出现在主线程的可打开卡片和右侧 Summary 中；主线程负责叙事，Summary 负责索引与回看。
- Composer 把权限、模型、执行模式与发送动作集中在同一决策面。

### 2. OpenYak 父任务

健康度：需要改进。

![OpenYak 父任务](/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/02-openyak-parent-task.png)

- 完成后的 10 个成员仍以一张大型 `AGENT SWARM PARALLEL` 卡片占据主叙事区。
- 卡片重复展示成员名、类型和 Completed 状态，却没有“这轮工作完成了什么”的父任务总结。
- 主内容区出现大量空白；过程没有像 Codex 那样收敛为可折叠 lifecycle 条目。
- 顶部强调模型，缺少稳定的任务标题与任务级 Tab 层级。
- Composer 同时分布 `Auto-edit`、`Ultra`、workspace chip 和顶栏模型，决策面被拆成三层。

### 3. OpenYak Workspace

健康度：部分良好。

![OpenYak Workspace](/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/03-openyak-workspace.png)

- 320px 右栏、圆角卡片、Outputs 与 Subagents 同卡的方向正确，已接近 Codex 的 300px Summary panel。
- 目前只有 `Outputs + Subagents + Context`，而 Sources 仍停留在消息级 popover；任务级产出与依据没有统一索引。
- Outputs 标题右侧 `+` 实际切换的是 Scratchpad 展开状态，图标语义与动作不一致。
- Outputs 文件列表没有随折叠状态收起，也没有 `aria-expanded`。
- Workspace 数据由全局单例 store 承载；并发子 Agent 的 todo/file 事件可能覆盖当前父任务的数据，造成结果归属不可信。

### 4. OpenYak Subagents 列表

健康度：接近基准。

![OpenYak Subagents 列表](/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/04-openyak-subagents.png)

- 已具备父任务作用域、Active/Done、明确空态、摘要、相对时间和错误重试。
- 14/20px 文本节奏和 48px 顶栏与 Codex 接近；头像不是信息理解的必要条件，可以不做。
- 当前 4 Active / 10 Done 是直接 `slice`，超过上限的 Agent 会被永久隐藏；Codex 使用同样首屏限制，但提供继续展开。
- 列表作为顶层 `/subagents` 路由会卸载 ChatView，并触发其他 panel 关闭；视觉上像 Tab，行为上却不是父任务内部 Tab。

### 5. OpenYak 子 Agent 详情

健康度：不足。

![OpenYak 子 Agent 详情](/Users/wangzhangwu/.codex/visualizations/2026/07/23/019f8d7b-3248-7570-9ce0-c7178585b1bd/05-openyak-subagent-detail.png)

- 当前完成态只剩标题和一段结果，页面极为空，用户看不到 delegated task、状态、耗时与结构化最终响应。
- Subagents 详情把 `isGenerating=false`、`streamId=null` 写死；活动 Agent 无法获得与父线程一致的实时观看体验。
- 主 Swarm 卡点击成员会跳到普通 child chat，而 Subagents 列表点击进入只读详情，形成两套互相冲突的入口。
- Codex 的详情契约是 `Status → Delegated task → Final response`，并区分 loading、unavailable、failed；这比直接复用普通 MessageList 更适合父任务审计。

## 优先级发现

### P1 — 先解决任务连续性

1. **把 Subagents 变成父任务内的视图，而不是独立页面。**
   应保留父任务、滚动位置、Composer、Workspace 和其他任务上下文；列表与 child detail 在同一个 Subagents tab 中切换。

2. **把 Workspace/Summary 状态改成 parent-session scoped。**
   `todos`、`workspaceFiles`、`scratchpad`、`sources`、`outputs` 和 subagent counts 都应按父任务保存；后台 session 事件不能直接覆盖当前可见任务。

3. **建立统一的 child detail 契约。**
   只保留一个入口和一个状态模型，显示 `Status / Delegated task / Final response`；活动 Agent 同时支持实时更新，完成后稳定持久化。

4. **把 Swarm 卡从主内容变成可折叠 activity timeline。**
   运行时显示 `Working for …` 和 concise progress；完成时显示 `Worked for …`，默认收起成员明细，由父 Agent 最终答复占据主叙事位。

### P2 — 补齐 Work Mode 信息架构

5. **建立任务级 Summary 数据模型。**
   建议顺序为 `Plan/Progress → Outputs → Subagents → Sources → Inputs`，无数据 section 自动隐藏；OpenYak 的 Memory/Skills/Connectors 可保留为独立 Context section。

6. **严格区分 Outputs 与 Sources。**
   Outputs 是类型化产物，应知道打开方式和来源 Agent；Sources 是 web、tool、connector、用户文件等依据，应支持首屏摘要、`View all` 和追溯。

7. **补上渐进披露。**
   4/10 是首屏密度，不是硬上限；必须提供 `Show N more`、滚动或完整列表。

8. **统一 Composer 决策面。**
   保留 OpenYak 的权限可见性、文件 mention、workspace 和 Ultra 资源提示，但把模型、权限和 execution topology 编排成一个清楚的层级，避免三层控件竞争。

### P3 — 最后做视觉与可访问性收口

9. **统一 Task/Tab shell。**
   父任务标题、Subagents tab、New chat、Workspace 状态和返回路径应使用同一 header 系统，不再分别手写 ChatHeader 与 Subagents header。

10. **修正错误 affordance。**
    Outputs 若是折叠动作，用 Chevron 并提供 `aria-expanded`；若保留 `+`，它必须代表真实的新增/附加动作。

11. **改善扫描与无障碍名称。**
    Subagents Summary 的 accessible name 应包含 working/done 数量；截断文本应可获得完整值；失败与运行状态继续使用文字而非只靠颜色。

12. **使用主题 token。**
    移除 `#2d2d2d`、`#242424`、`white/*` 等硬编码，保证浅色主题和平台 title bar 一致。

## 已有强项，应保留

- 父任务作用域的 Subagents API、Active/Done 分类、相对时间、空态与错误恢复。
- `h1/h2`、`role=alert`、语义化 `<time>` 和清楚的 focus ring。
- 多 session 流继续在后台运行的基础设施。
- Outputs 与 Subagents 已进入同一张右栏卡片的方向。
- OpenYak 的 project/session、workspace memory、skills、connectors 和本地模型能力。
- 权限、模型与 Ultra 资源消耗的可见性。
- 多平台与浅色主题支持。

## 明确不学

- 子 Agent 头像或彩色身份图案。
- Codex 专有图标、插画和 Mac 窗口控件。
- 为追求截图相似而硬编码深色、固定窗口尺寸或像素值。
- 没有实际任务语义的装饰性 `+`、截图卡片或动画。
- 隐藏权限、模型、执行成本或失败原因。
- 用 Codex 的项目组织方式替换 OpenYak 已有的 project/memory/connector 体系。

## 本机 Codex 实现核对

只读检查确认以下并非截图推测，而是当前安装包中的正式交互契约：

- 主线程仍是 header → transcript → composer，Summary 可 overlay 或 pinned。
- Summary 常见顺序会收敛为 Outputs → Subagents → Sources；每个 section 有独立计数与折叠。
- Summary overlay 为 300px，使用滚动容器与 sticky header。
- Subagents Active 首屏 4 条、Done 首屏 10 条，并使用通用分页组件继续展开。
- child detail 明确显示 Status、Delegated task、Final response 及 loading/unavailable。
- `Worked for` 是有 started/completed timestamp 的 lifecycle item，并可折叠之前的 activity。
- Sources 首屏限制后提供 `View all`；Outputs 是类型化产物，而不是普通附件集合。

主要证据位于：

- `/Applications/ChatGPT.app/Contents/Resources/app.asar`
- `webview/assets/local-conversation-page-MX2XDodp.js`
- `webview/assets/local-conversation-thread-DCRNRufR.js`
- `webview/assets/app-initial~app-main~onboarding-page~hotkey-window-thread-page~debug-window-page~appearance~o4fm6wvw-C20BtzWH.js`

## OpenYak 代码证据

- `frontend/src/stores/workspace-store.ts:39`：Workspace 为单例状态。
- `frontend/src/lib/session-stream-registry.ts:421`：任意 session 的 tool result 会直接更新 Workspace。
- `frontend/src/components/workspace/subagents-summary-card.tsx:26`：摘要跳转顶层 `/subagents`。
- `frontend/src/app/(main)/layout.tsx:142`：路由变化关闭 overlay panels。
- `frontend/src/components/chat/chat-view.tsx:90`：进入 chat 时重置 Workspace。
- `frontend/src/components/subagents/subagents-page.tsx:17`：4/10 上限。
- `frontend/src/components/subagents/subagents-page.tsx:35`：直接 `slice`，无继续展开。
- `frontend/src/components/subagents/subagents-page.tsx:62`：详情强制非生成态。
- `frontend/src/components/parts/swarm-part.tsx:59`：主 Swarm 卡走普通 child chat 路由。
- `frontend/src/components/workspace/files-section.tsx:114`：Outputs 的 `+` 触发折叠状态，但没有匹配的视觉/ARIA 语义。
- `frontend/src/components/chat/chat-form.tsx:582`：当前 Composer 的三层结构。

## 建议实施顺序与验收

### Milestone 1：任务状态归属

- Workspace/Summary 按 parent session 隔离。
- 父任务、Subagents list、child detail 切换不卸载任务壳。
- 同一 child 只有一个详情入口，活动与完成态都能恢复。

验收：同时运行多个父任务和多个子 Agent，切换页面后 Outputs、Sources、进度和 child 状态不串、不丢、不中断。

### Milestone 2：Work Mode 信息架构

- 引入任务级 Summary model。
- Outputs/Subagents/Sources/Inputs 使用统一 section contract。
- 主线程使用 lifecycle item 与最终父任务总结，Swarm 明细完成后默认收起。

验收：用户不打开 child detail，也能回答“正在做什么、谁做的、产出了什么、依据是什么、耗时多久”。

### Milestone 3：交互收口

- 统一 Task/Tab header 和 Composer 层级。
- 补全 Show more/View all、正确图标语义、可访问名称、完整 tooltip、主题 token。
- 验证 keyboard、focus restore、loading/error、reduced motion 与浅色主题。

验收：鼠标与键盘均可完成父任务 → Subagents → child → 返回父任务的完整闭环，且焦点、滚动和打开的 Workspace 状态可预测。

## 实施闭环（最终复验）

截至 2026-07-23 的最终实现与浏览器复验，以上发现已形成闭环：

| 原发现 | 最终状态 |
| --- | --- |
| P1.1 父任务内 Subagents 视图 | 已完成；父 ChatView 保持挂载，列表与 child detail 在同一任务壳内切换 |
| P1.2 parent-session scoped Summary | 已完成；workspace、outputs、sources、inputs 与计数按父任务隔离 |
| P1.3 统一 child detail | 已完成；统一展示 Status、Delegated task、Final response，并支持 live/terminal/retry 状态 |
| P1.4 Swarm activity timeline | 已完成；Swarm/Subtask 收敛为紧凑 Agent pills 与相邻生命周期，详情渐进展开 |
| P2.5 任务级 Summary | 已完成；Progress、Outputs、Subagents、Sources、Inputs、Context 共用任务级结构 |
| P2.6 Outputs / Sources 区分 | 已完成；产物与依据使用不同 section、打开语义和追溯路径 |
| P2.7 渐进披露 | 已完成；列表与 Summary 提供 Show more / View all，不再以 slice 作为硬上限 |
| P2.8 Composer 决策面 | 已完成；附件、权限、workspace、模型、Ultra 与发送动作收敛到同一 Composer |
| P3.9 Task/Tab shell | 已完成；父任务、Subagents 与 child detail 保持统一 header 与返回路径 |
| P3.10 affordance | 已完成；折叠使用真实 disclosure 语义与 `aria-expanded`，移除误导性装饰 `+` |
| P3.11 扫描与无障碍 | 已完成；数量进入 accessible name，状态有文字，截断内容可恢复，焦点可预测 |
| P3.12 主题 token | 已完成；本轮涉及 surface、border、text、focus 与 motion 均使用现有主题系统 |

Conversation 的最后一轮还补齐了 Codex 式 Work Event Timeline：正文、工具活动、Agent 协作、Compaction 与后续工作严格保持真实 Part 顺序；相邻 reasoning/tool 只在同一 step 内聚合；流式正文与 reasoning 缓冲会在 Tool 开始前同步落下，保证 prose → tool 顺序稳定且旧文本光标立即消失；主正文使用 736px 阅读轨与 15px / 1.55 排版；Stop 与 Compaction 都收敛为轻量 lifecycle 行。

父任务 Summary 的证据链路也已完成闭环：有效的直接与嵌套 descendants 会被递归聚合；Outputs 按 path、Sources 按规范 URL 去重，但每个 parent/child、Agent run、terminal status 与 tool origin 都会保留。真实 connector 结果来自 ToolPart metadata、明确的 web/MCP JSON object/list output、协议级 `structuredContent`、`ResourceLink` 或嵌入资源 URI，并统一进入有深度、节点数、条数、总字节和 metadata 上限的结构化提取器；普通 Read/Bash/Code JSON 不会被误识别为 Sources。合法的 `source_evidence` 即使为空也具有权威性，不会再回退扫描 raw metadata/output。超过 50 KiB / 2,000 行的结果会在常规输出截断前只提取精简、版本化的证据 envelope，原始 payload、padding、附件和完整 tool output 不会被错误替换；超过 512 项的 MCP 内容、64 KiB metadata 与超大平面容器都有明确预算。普通文本 URL、callback/pagination/decorative 字段、凭据路径和查询、title/snippet 中的凭据赋值、token/signature query 与非 HTTP(S) URI 均被拒绝。

最终交互收口同时覆盖真实可用宽度下的 Summary overlay/pinned 决策、窄宽 Composer 自动换行、`waiting_input` 在 Summary/列表/可访问名称中的一致表达，以及 Activity 按钮的 disclosure 语义、稳定 panel 标识和关闭后的焦点恢复。对应验证为后端来源/MCP/截断定向回归 49/49、完整后端回归 1145 passed / 21 skipped、前端 unit 51/51，以及 Conversation、Agent Swarm、Stop、Work Mode shell、Summary、Subagents 与 child evidence 的 Chromium 回归 41/41。

最终同视口与聚焦对照证据、交互复验和自动化结果记录在仓库根目录 `design-qa.md`。独立视觉契约审计与 provenance/security 审计均确认 P0 0、P1 0、P2 0。本轮没有复制 Agent 头像、Codex 专有图标或 Mac 窗口装饰。

## 证据限制

- 系统未允许自动控制正在运行的本地 Codex 窗口，因此没有直接录制 hover、键盘、loading、error 和动画状态。
- 本次通过用户提供的当前截图、OpenYak 新鲜运行态、OpenYak 源码以及本机 Codex 安装包的只读组件结构进行交叉验证。
- 当前视觉截图主要覆盖桌面端完成态；移动端、浅色主题和长列表超过 10 项后的 OpenYak 运行态需在实施阶段补充验证。
