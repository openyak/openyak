# OpenYak

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/lang-English-blue?style=flat-square" alt="English" /></a>
  <img src="https://img.shields.io/badge/status-v2%20alpha-orange?style=flat-square" alt="Status: v2 alpha" />
</p>

<h3 align="center">One chat. Every agent.</h3>

<p align="center">
  跑在你电脑上的所有 AI agent，一个统一的入口。
</p>

---

> **OpenYak 正在重构。** 当前分支是 v2，早期 alpha，方向已变。
> v1（自带 runtime、Computer Use、办公文档流程的本地优先桌面 agent）完整保留在
> [`legacy/v1`](https://github.com/openyak/openyak/tree/legacy/v1) 分支和
> [v1.5.0 release](https://github.com/openyak/openyak/releases/tag/v1.5.0)。
> 原因见[公告](https://github.com/openyak/openyak/discussions/190)。

## 想法

**你不该被迫在 AI 应用之间做选择。只要说你想做什么。**

Claude Code、Codex、Gemini，以及下个月还会冒出来的那些，每一个都想成为你常驻的那个应用。
OpenYak 把它们当作它们正在变成的东西：**runtime provider**。每一个都自带模型、工具、权限和登录。
它们都没有给你的，是上面那一层：一段属于你自己的对话，谁都可以接着做，
你中途换人也不用重来。

这就是整个产品。不是把 AI 应用聚合起来，而是让 AI 应用本身不再重要。

- **对话是你的。** 对话记录由 OpenYak 持有。agent 来来去去，线不断。
- **agent 是 runtime。** OpenYak 不带模型、不带工具、不存 key、不做权限引擎。它通过开放的
  [Agent Client Protocol](https://agentclientprotocol.com) 驱动你已经装好并登录的 agent，
  它们的选项和权限确认原样呈现。
- **切换零成本。** 一件事做到一半从 Codex 交给 Claude Code，新 agent 拿到它错过的那几轮接着做。
  不用复制粘贴，不用新开对话，不用碰终端。
- **往哪走。** 现在每条消息由你选 agent。方向是你不再注意到这件事是谁做的，
  就像你从来不会去想浏览器这次用的是 CPU 的哪个核。

## 状态

v2 是 alpha：能跑，还不精致，形态会变。已可用：

- 每个 Task 一段持久的 Chat，由 OpenYak 持有，不依赖任何 agent。Task 归属于 Project（agent 运行的目录）
- Chat 由 `claude`（通过 `@agentclientprotocol/claude-agent-acp`）或 `codex`（通过 `@agentclientprotocol/codex-acp`）服务，逐条消息可选
- 流式文本、思考、工具调用与权限确认
- agent 交接：任务内切换 agent 并保留上下文，重启后也在
- agent 自己的会话选项（模型、推理强度、权限模式……）显示在 Chat 顶栏，与 agent 暴露的完全一致，按 Task 记住

尚未：安装包；更多 agent（Gemini CLI、Grok，以及任何会说 ACP 的）；替你选 agent；Linux / Windows 验证。

## 运行

前提：Node 26 与 Rust 1.90（`mise install` 一次装好），以及本机已登录的
[Claude Code](https://docs.anthropic.com/en/docs/claude-code)（运行过一次 `claude`）和/或
[Codex](https://github.com/openai/codex)（`codex login`）。agent 本身随 app 内置，只借用你的登录。

```bash
git clone https://github.com/openyak/openyak.git
cd openyak
npm install
npm run dev
```

## 结构

```
app/    Electron + React     — Chat，以及围绕它的 Project / Task。只和 core 通信
core/   Rust (openyak-core)  — SQLite 对话存储 + 拉起 agent 的 ACP 客户端
docs/   architecture.md, core-protocol.md
```

详见 [`docs/architecture.md`](docs/architecture.md) 与 [`docs/core-protocol.md`](docs/core-protocol.md)。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
