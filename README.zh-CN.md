# OpenYak

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/lang-English-blue?style=flat-square" alt="English" /></a>
  <img src="https://img.shields.io/badge/status-v2%20alpha-orange?style=flat-square" alt="Status: v2 alpha" />
</p>

<h3 align="center">Project → Task → Chat。由你已经装好的 coding agent 来服务。</h3>

<p align="center">
  一个工作台，同时驱动 Claude Code、Codex 以及后来者。任务中途切换 agent，上下文不断。
</p>

---

> **OpenYak 正在重构。** 当前分支是 v2，早期 alpha，方向已变。
> v1（自带 runtime、Computer Use、办公文档流程的本地优先桌面 agent）完整保留在
> [`legacy/v1`](https://github.com/openyak/openyak/tree/legacy/v1) 分支和
> [v1.5.0 release](https://github.com/openyak/openyak/releases/tag/v1.5.0)。

## 想法

Claude Code、Codex、Gemini CLI 都在做同一套 UI、同一件事，每一个都想成为你唯一的工作台。
OpenYak 押另一边：

- **agent 你已经有了。** OpenYak 不自带模型运行时、工具或 API key，而是通过开放的
  [Agent Client Protocol](https://agentclientprotocol.com) 驱动你已安装并登录的 CLI。
- **以任务为中心，而不是以厂商为中心。** 工作组织为 Project → Task → Chat，agent 是每条消息的选择，不是一次性的绑定。
- **切换不丢上下文。** OpenYak 持有规范的对话记录。把任务从 Codex 交给 Claude Code 时，新 agent 只会拿到它错过的那几轮。
- **只做一件事。** 没有插件、浏览器自动化、文档管线。agent 自己能做的事，就交给 agent。

## 状态

v2 是 alpha：能跑，还不精致，形态会变。已可用：

- Project（一个目录）、Project 下的 Task、每个 Task 一个 Chat
- Chat 由 `claude`（通过 `@agentclientprotocol/claude-agent-acp`）或 `codex`（通过 `@agentclientprotocol/codex-acp`）服务，逐条消息可选
- 流式文本、思考、工具调用与权限确认
- agent 交接：任务内切换 agent 并保留上下文
- agent 自己的会话选项（模型、推理强度、权限模式……）显示在 Chat 顶栏，与 agent 暴露的完全一致，按 Task 记住

尚未：安装包、Grok 等更多 agent、Linux / Windows 验证。

## 运行

前提：Node 26 与 Rust 1.90（`mise install` 一次装好），以及至少一个已登录的
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) 或 [Codex CLI](https://github.com/openai/codex)。

```bash
git clone https://github.com/openyak/openyak.git
cd openyak
npm install
npm run dev
```

## 结构

```
app/    Electron + React     — Project / Task / Chat 界面，只和 core 通信
core/   Rust (openyak-core)  — SQLite 对话存储 + 拉起 agent 的 ACP 客户端
docs/   architecture.md, core-protocol.md
```

详见 [`docs/architecture.md`](docs/architecture.md) 与 [`docs/core-protocol.md`](docs/core-protocol.md)。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
