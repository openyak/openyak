# Atlas Cloud Provider Review

## 变更概览

- 新增内置 BYOK provider：`Atlas Cloud`
- 接入方式复用现有 OpenAI-compatible provider 机制
- 补充本地配置项：`OPENYAK_ATLAS_API_KEY`
- 更新中英文 README Provider 列表，并加入 Atlas Cloud 展示图片
- 补充最小后端测试，锁定 catalog 与 provider factory 行为

## 具体改动

### 1. Provider 接入

- 在 `backend/app/provider/catalog.py` 新增 `atlas` provider
- Base URL 配置为 `https://api.atlascloud.ai/v1`
- Display Name 配置为 `Atlas Cloud`
- 复用现有 `openai_compat` 路径，不新增专用 adapter

### 2. 配置项补充

- 在 `backend/app/config.py` 新增 `atlas_api_key`
- 在 `backend/.env.example` 补充 `OPENYAK_ATLAS_API_KEY` 示例
- 已按要求把你提供的 key 持久化到本地未跟踪文件：`backend/.env`

### 3. 前端文案

- 在设置页中英文文案中新增 `providerKeyPlaceholder_atlas`
- 这样 Atlas Cloud 会在现有 BYOK provider 面板中自然显示并可输入/保存 key

### 4. README 与图片

- 在 `README.md` 与 `README.zh-CN.md` 的 Optional Cloud Providers 表格中加入 `Atlas Cloud`
- 官方链接使用了带 UTM 的项目链接：
  - `https://www.atlascloud.ai/?utm_source=github&utm_medium=link&utm_campaign=openyak`
- 按要求加入图片资源：
  - `docs/readme/atlas-cloud-provider.png`

### 5. 测试

- 新增测试文件：`backend/tests/test_provider/test_atlas_provider.py`
- 覆盖点：
  - `PROVIDER_CATALOG["atlas"]` 配置正确
  - `create_provider("atlas", ...)` 会创建正确的 OpenAI-compatible provider
  - Atlas Cloud 实时流式调用可用
  - OpenAI 回归 smoke 预留为可选测试，仅在本地存在 key 时运行

## 本地验证结果

### 已通过

- 代码级验证：
  - Atlas Cloud provider 已能被 OpenYak 正常注册
  - `https://api.atlascloud.ai/v1/models` 可返回模型列表
  - OpenYak 内置 provider 可对 `deepseek-ai/DeepSeek-V3-0324` 成功发起流式请求
- 自动化测试：
  - `tests/test_provider/test_atlas_provider.py`
  - `tests/test_api/test_custom_endpoint_schema.py`
  - 结果：`83 passed, 1 skipped`
- 参考项目对比验证：
  - 复用了 `ai-hands-on` 中已验证可用的 Atlas 调用方式
  - 确认默认可用模型为 `deepseek-ai/DeepSeek-V3-0324`

## 调试结论

- `ai-hands-on` 里的 Atlas 调用方式对当前 key 可用
- OpenYak 的 Atlas provider 也已完成真实流式调用验证
- Atlas Cloud 接入不需要额外自定义请求头，也不需要专用 adapter
- 默认工作模型采用 `deepseek-ai/DeepSeek-V3-0324`，而不是文档里的简写 `deepseek-v3`

## 建议下一步

- 后续如果你希望把 OpenAI/Anthropic 等云端 provider 回归也纳入仓库 CI，需要补专门的 secrets 和 live test job
- 当前这次改动已经满足本地 provider 集成、文档更新、真实 Atlas 调用验证和提 PR 条件
