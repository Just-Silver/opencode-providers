---
name: opencode-providers registry
description: Use when adding or changing providers or models in this repository's registry/registry.json — 新增供应商（id / 显示名 / 协议包 / baseURL）、给某家加模型（modelID / limit / 变体）、改 baseURL 或上下文长度，或用户说「维护注册表 / 把某家加进去 / 加个模型」
---

# registry.json 维护

`registry/registry.json` 是本仓**唯一事实源**：插件运行期从 GitHub raw 拉它（6h TTL + `ETag` + 失败沿用旧缓存）。
**改数据不需要发插件版本**，但要让运行中的实例跟上：`git push origin main` → 触发一次插件重载（`install.ps1 -Local` / 重启），否则最多等 6h。

## 两种路由

| 路由 | 场景 | 收集项 |
|---|---|---|
| **A 新增供应商** | 这家还不存在于注册表 | 供应商 id、显示名称、协议（→ package）、baseURL |
| **B 给已有供应商加模型** | 供应商已在注册表，只加/改模型 | 模型 key、显示名称、上游 `modelID`、`limit`、变体 |

不在本技能范围：改插件代码 / `registry.schema.json` / 加 `env` 认证 / 账号重命名删除。

## 铁律：只用最小字段

**允许出现的字段只有这些**：
provider 级 → `name`、`package`、`baseURL`、`models`；模型级 → `name`、`modelID`、`limit`（`context`/`output`）、`variants`（`id` + 可选 `settings`）。
**只有多家共用同一个模型（参数相同）时**，才允许额外用顶层 `models` 表 + 模型里的 `base` 引用；单家供应商一律**内联**写在自己的 `models` 里。

**不要自行添加**（用户明确要求才写）：`keyLabel`（默认就是 `Paste API key`）、`settings`、`headers`、`body`、`canonical`、
`env`、`apiKey`、`cost`、`tools`、`input`、`output`、`family`、`status`、`releaseDate`、`disabled`、
`reasoningField`、`maxTokensField`。

- **绝不写 `env` / `apiKey`**：本项目只走 `/connect`，key 存 opencode 自己的凭据表（写进注册表会明文落盘、且绕过 `/connect`）。
- **参数不猜**：`limit.context` / `limit.output` 缺一个就不写这条模型，先问用户。

## 一次性收集（用 `question` 工具，一次调用问完）

调用 `question`，把该路由**所有缺失项放进同一个 `questions` 数组**；用户已经给出的字段**不要重复问**（只问差的）。

- **路由 A（4 问）**：① 供应商 id（`provider/model` 的前缀）② 显示名称
  ③ 协议形态（`/v1/chat/completions`、`/v1/responses`、`/v1/messages`，默认第一个）④ baseURL（通常以 `/v1` 结尾）
- **路由 B（5 问）**：① 模型 key（在 opencode 里的模型 id）② 显示名称 ③ 上游 `modelID`（不发往上游就同 key）
  ④ `limit.context` / `limit.output` ⑤ 变体（`id` + 可选的 `settings`，如 `reasoningEffort`）

## 模板（最小可用）

```jsonc
// registry/registry.json → providers.<供应商id>
{
  "供应商id": {
    "name": "显示名称",
    "package": "@opencode/ai/providers/openai-compatible",
    "baseURL": "https://llm.example.com/v1",
    "models": {
      "模型key": {
        "name": "显示名称",
        "modelID": "发给上游的真实模型 id",
        "limit": { "context": 1048576, "output": 393216 },
        "variants": [
          { "id": "low", "settings": { "reasoningEffort": "low" } },
          { "id": "high", "settings": { "reasoningEffort": "high" } }
        ]
      }
    }
  }
}
```

## 协议 → package（3 种形态）

判据：**看上游文档 curl 示例的路径**，不是看模型名字。V1 文档原话（`packages/web/src/content/docs/providers.mdx:2506`）：
「`@ai-sdk/openai-compatible` … **for `/v1/chat/completions`**；若用 `/v1/responses` 则用 `@ai-sdk/openai`」——V2 按同样的路径区分。

| 上游请求路径（形态） | package |
|---|---|
| `/v1/chat/completions`（OpenAI **chat**，多数网关默认） | `@opencode/ai/providers/openai-compatible` |
| `/v1/responses`（OpenAI **responses**） | `@opencode/ai/providers/openai-compatible/responses`（OpenAI 官方端点用 `@opencode/ai/providers/openai/responses`） |
| `/v1/messages`（Anthropic **messages**） | `@opencode/ai/providers/anthropic-compatible`（Anthropic 自家 API 用 `@opencode/ai/providers/anthropic`） |

拿不准就问用户：「上游是 `/v1/chat/completions`、`/v1/responses` 还是 `/v1/messages`？」

其它族（**不属于**上面 3 种，用户点名要用时才写）：`google`（Gemini 原生 `/v1beta/models/{model}:generateContent`）、
`google-vertex`、`azure`、`amazon-bedrock`、`openai`（原生）、`xai`、`openrouter` 等，完整清单见官方文档
<https://opencode.ai/v2/docs/providers/#packages>。

> 已核实（`@opencode/ai` **2.0.24** 源码）：上面三个入口文件 `providers/openai-compatible.ts`、
> `providers/openai-compatible/responses.ts`、`providers/anthropic-compatible.ts` 都存在；
> 分别走 `protocols/openai-compatible-chat`、`protocols/openai-compatible-responses`、`protocols/anthropic-messages`。
> （`openai` / `openai/chat` / `openai/responses` / `anthropic` / `google` / `google-vertex` 也都在。）

## 同一模型被多家共用：顶层 `models` + `base`

多家提供同一个模型时，把**共享参数**写到顶层 `models`，各 provider 用 `base` 引用，再覆盖差异（如 `modelID`）。
本仓实例：`deepseek-v4.1-flash` 被 `command-code`（`modelID: deepseek/deepseek-v4.1-flash`）与 `r4-coder`（默认 = key）共用。

## 步骤（每次改完都要走完）

1. 读 `registry/registry.json`，按最小字段改（沿用现有缩进与键顺序）
2. `node --test` —— 会校验随仓注册表能通过 `parseRegistry`，并断言现有两家的参数
3. `git add -A && git commit -m "…"`（**中文**）→ `git push origin main`
4. 让运行中的实例生效：`pwsh -NoProfile -File .\install.ps1 -Local`（脚本安装）或重启 opencode
5. 验证：
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Just-Silver/opencode-providers/main/registry/registry.json   # 200 且含新条目
   opencode api get /api/integration   # 新供应商出现，且 metadata.source=opencode-providers
   opencode api get /api/model         # 在 /connect-providers 粘 key 后，模型数与 limit/modelID 对得上
   ```

## 常见错误

| 现象 | 原因 / 处理 |
|---|---|
| 插件 `active` 但注册 0 条 | 注册表不可用：先 `curl` raw URL 是否 200，再 `node --test` 看是否校验失败 |
| 改完没生效 | 没 push，或没触发重载（TTL 6h 内会沿用缓存） |
| `/api/model` 里没这家 | 正常：`activation: auto`，要在 `/connect-providers` 里存过 key 才出现 |
| 和 `opencode.json` 的 `providers.<id>` 撞名 | 同 id **只留一边**；配置那份还会注入 `activation: enabled` 与明文 key |
| 上游 400/404 | `modelID` 写错：要写**上游真实** id，不是 opencode 里的别名 |
| 变体不生效 | `settings` 必须在 `variants[].settings`，不是模型级 `settings` |
