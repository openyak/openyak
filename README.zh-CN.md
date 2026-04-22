[English](README.md)

<p align="center">
  <img src="OpenYak-Logo/mascot.png" width="200" alt="OpenYak 吉祥物" />
</p>

<h1 align="center">Yak is all you need.</h1>

<p align="center"><strong>你的本地 AI Agent — 编辑文件、运行工作流、接入你想要的模型。</strong></p>

<p align="center">
  <a href="https://github.com/openyak/desktop/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/openyak/desktop/ci.yml?branch=main&style=flat-square&label=Tests %26 Type Check" alt="Tests & Type Check" /></a>
  <a href="https://github.com/openyak/desktop/stargazers"><img src="https://img.shields.io/github/stars/openyak/desktop?style=flat-square" alt="GitHub Stars" /></a>
  <a href="https://github.com/openyak/desktop/blob/main/LICENSE"><img src="https://img.shields.io/github/license/openyak/desktop?style=flat-square" alt="License" /></a>
  <a href="https://github.com/openyak/desktop/releases/latest"><img src="https://img.shields.io/github/v/release/openyak/desktop?style=flat-square" alt="Latest Release" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue?style=flat-square" alt="Platform: macOS | Windows" />
  <a href="https://github.com/openyak/desktop/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs Welcome" /></a>
</p>

<p align="center">
  <img src="OpenYak-Logo/openyak-1.1.2.gif" width="800" alt="OpenYak Demo" />
</p>

---

## 为什么选择 OpenYak

- **整理 500 份合同，无需上传任何文件。** OpenYak 运行在你的桌面上，直接访问本地文件系统 — 你的数据永远不会离开你的设备。

- **一键从 GPT-4o 切换到 DeepSeek。** 100+ 云端模型、20+ API 提供商，或通过 [Ollama](https://ollama.com) 完全离线运行。不锁定任何平台。

- **让 AI 处理繁琐的工作。** 20+ 内置工具 — 读写文件、重命名、执行命令、解析表格、起草文档 — 全部在本地完成。

- **手机扫码，即刻连接。** 开启远程访问，扫一下二维码，手机就能控制桌面 AI。基于 Cloudflare Tunnel 自动 HTTPS — 无需端口转发，无需配置。

- **无需注册账号。** 下载即用，没有注册、登录、邮箱验证。免费模型开箱即用。

- **免费起步，无需绑卡。** 每周 100 万免费 Token。高级模型按 API 原价计费，零加价。

## 下载

| 平台 | 架构 |
|------|------|
| macOS | Apple Silicon |
| macOS | Intel |
| Windows | x64 |

> **[下载最新版本](https://github.com/openyak/desktop/releases/latest)** 或访问 [open-yak.com/download](https://open-yak.com/download/)

## 开始使用

1. **下载** 上方表格中对应平台的安装包
2. **连接模型** — 即刻使用免费云端模型，充值使用高级模型，接入 20+ 提供商的 API 密钥，或通过 [Ollama](https://ollama.com) 完全本地运行
3. **开始工作** — 管理文件、分析数据、生成办公文档

## 应用场景

**文件管理** — 跨文件夹重命名、排序、清理文件。设置定时任务 — 每日收件箱整理、每周下载清理 — 交给 Yak 按计划执行。

**文档与表格生成** — 将笔记转化为格式化报告、带公式的电子表格和可导出的 PDF。AI 直接生成可用的文件 — 而不是需要你复制粘贴再排版的纯文本。

**数据分析** — 在本机解析电子表格、CSV 和文档。发现趋势、标记异常、导出报告 — 你的数据始终留在设备上。

**研究与综合** — 从 PDF、本地文件和网页中提取信息。跨来源汇总、提炼要点、生成结构化简报 — 直接可用，不是未加工的素材堆砌。

**远程访问** — 在桌面端扫描二维码，手机即刻打开 OpenYak。从手机发送任务，桌面端本地执行，随时查看结果。基于 Cloudflare Tunnel — 无需账号、无需端口转发、自动 HTTPS。支持多种权限模式：自动批准安全操作、逐一审批、或仅查看。

通过内置连接器接入 46+ 服务 — Slack、Notion、GitHub、Figma 等。也可以通过 MCP 添加你自己的连接器。

## 支持的模型提供商

### 云端（通过 API）

| 提供商 | 接入方式 | |
|--------|---------|--|
| OpenRouter | 内置 | 100+ 模型，含免费额度 |
| OpenAI | BYOK | ⭐ 推荐 |
| Anthropic | BYOK | ⭐ 推荐 |
| Google | BYOK | |
| DeepSeek | BYOK | |
| Groq | BYOK | |
| Mistral | BYOK | |
| xAI | BYOK | |
| 通义千问 (Qwen) | BYOK | ⭐ 推荐 |
| Kimi (月之暗面) | BYOK | |
| MiniMax | BYOK | ⭐ 推荐 |
| 智谱 (ZhiPu) | BYOK | |
| ChatGPT | 订阅直连 | 使用你现有的 ChatGPT Plus/Team 方案 |

### 本地（通过 Ollama）

运行 [Ollama](https://ollama.com) 上的任何模型 — 完全离线、自动检测、支持工具调用。

> **BYOK** = Bring Your Own Key（自带密钥）。使用你自己的 API 密钥，零加价、无中间商。

## 开发者

**技术栈**：Tauri v2 (Rust) + Next.js 15 + FastAPI + SQLite

**Monorepo 结构**：

```
desktop-tauri/    Rust — 桌面外壳，系统集成
frontend/         Next.js 15 — 聊天 UI、状态管理、SSE 流式传输
backend/          FastAPI — Agent 引擎、工具执行、LLM 流式传输、存储
```

**快速开始**：

```bash
npm run dev:all    # 启动后端 (端口 8000) + 前端 (端口 3000)
```

完整技术细节、项目结构和开发环境配置，请参阅 [frontend/README.zh-CN.md](frontend/README.zh-CN.md) 和 [backend/README.zh-CN.md](backend/README.zh-CN.md)。

## FAQ

<details>
<summary>我的数据会离开本机吗？</summary>

不会。所有文件、对话和记忆都存储在你的设备本地。唯一发送到外部的数据是使用云端模型时的提示词文本 — 而且直接发送到模型提供商的 API。无遥测、无分析统计、无云端存储。
</details>

<details>
<summary>免费吗？</summary>

是的。OpenYak 通过 OpenRouter 提供每周 100 万免费 Token，零费用。高级模型按 OpenRouter 原价计费，零加价。你也可以使用 20+ 提供商的自有 API 密钥，或通过 Ollama 完全免费离线运行。
</details>

<details>
<summary>可以离线使用吗？</summary>

可以。安装 Ollama，下载一个模型，OpenYak 即可完全离线工作，无需联网。OpenYak 自动检测本地 Ollama 模型，并支持完整的工具调用。
</details>

<details>
<summary>支持哪些模型？</summary>

通过 OpenRouter 接入 100+ 云端模型，20+ BYOK 提供商支持直接 API 密钥接入，以及通过 Ollama 可运行的任何本地模型。新模型上线即可使用。完整列表请参阅上方「支持的模型提供商」。
</details>

<details>
<summary>需要注册账号吗？</summary>

不需要。OpenYak 无需注册、登录或邮箱验证。下载后即可直接使用。免费云端模型开箱即用。使用高级模型只需添加 API 密钥或充值额度 — OpenYak 本身不需要任何账号。
</details>

<details>
<summary>远程访问是怎么工作的？</summary>

在设置中开启远程访问，OpenYak 会生成一个二维码。用手机摄像头扫描后，会打开一个通过 Cloudflare Tunnel 连接到你桌面 AI 的移动网页应用，自动 HTTPS 加密。无需端口转发，无需 Cloudflare 账号。你可以从手机发送任务，桌面端在本地执行。基于 Token 的认证保障连接安全，随时可以撤销访问或轮换 Token。
</details>

<details>
<summary>和 ChatGPT 或 Claude.ai 有什么区别？</summary>

OpenYak 运行在你的桌面上，可以直接访问你的本地文件和系统。它可以读取、编写和整理你的文件，执行命令，自动化工作流 — 同时你的数据始终留在本机。网页版助手无法访问你的本地文件系统。
</details>

## 社区

- **提问与讨论** — [GitHub Discussions](https://github.com/openyak/desktop/discussions)
- **Bug 反馈** — [GitHub Issues](https://github.com/openyak/desktop/issues)
- **参与贡献** — [CONTRIBUTING.md](CONTRIBUTING.md) — 欢迎 PR 和反馈

## Star History

如果 OpenYak 对你有帮助，欢迎点个 Star — 帮助更多人发现这个项目。

<a href="https://star-history.com/#openyak/desktop&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=openyak/desktop&type=Date&theme=dark" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=openyak/desktop&type=Date" width="600" />
 </picture>
</a>

## 许可证

[MIT](LICENSE)
