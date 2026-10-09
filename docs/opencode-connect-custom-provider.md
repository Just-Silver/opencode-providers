# `/connect` 自定义供应商（models.dev 里没有的怎么补）

<!-- 职责（通用知识）：opencode 的 `/connect` 与自定义供应商三条路线。不写本插件的安装 / 使用。 -->

> 本文以 **OpenCode V2** 为准（文档：<https://opencode.ai/v2/docs/>）。
> 源码：`E:\Code\Projects\Agent\Externals\opencode`，checkout = v2.0.23（commit `e2d540042a`）。
>
> **更正记录（2026-10-07）**：本文初版把 V2 `package` 写成 `aisdk:@ai-sdk/openai-compatible` —— **错**。
> `aisdk:` 是 V1 迁移用的**旧/内部写法**；V2 原生写法是 `@opencode/ai/providers/*`。已按 V2 文档改正。

结论：**能补，有三条路**；「补不了」的只有内置插件清单本身。

## `/connect` 的供应商列表从哪来

TUI 侧：`/connect`（`provider.connect`）→ `DialogIntegration` → `data.location.integration.list(location)`
（`packages/tui/src/component/dialog-integration.tsx:84-88`，**不过滤可用性**，列出的就是服务端 registry 里的全部 integration）。

服务端 registry 由内置插件填充（`packages/core/src/plugin/internal.ts`）：

| 来源 | 位置 | 行为 |
|---|---|---|
| models.dev 目录 | `packages/core/src/plugin/models-dev.ts:34-51` | 为每个 `environment.length > 0` 的目录供应商注册 integration + `key` method（无 label）+ `env` method |
| **你的配置** | `packages/core/src/config/plugin/provider.ts:23-42` | 为配置里声明的每个供应商注册 integration；若不存在则加 `key` method（label「Manually enter API Key」）；有 `env` 则再加 `env` method |
| 内置 provider 插件 | `packages/core/src/plugin/provider/*.ts` + `plugin/provider.ts:34` | openai/anthropic/copilot 等，注册 oauth/command/key method |

→ **models.dev 目录 + 配置声明 + 插件注册** 三者并集就是 `/connect` 的内容。

## 路线 A：配置声明（推荐，零代码）

### V2 写法（当前）

`opencode.jsonc` 的根键是 **`providers`**（复数），`package` 用 **`@opencode/ai/providers/*`**：

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "acme": {
      "name": "Acme",
      "env": ["ACME_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://llm.acme.example/v1" },
      "models": {
        "qwen3-coder": { "name": "Qwen 3 Coder" }
      }
    }
  }
}
```

字段（V2 文档 + `packages/schema/src/config/provider.ts:93-100`）：

| 字段 | 用途 |
|---|---|
| `name` | 显示名 |
| `env` | 有序的环境变量名，可提供凭据（服务端进程读取，不落盘） |
| `package` | 运行时 provider 包（见下） |
| `canonical` | 继承某个内置供应商的目录默认值 |
| `settings` | OpenCode 控件 + 透传给运行时包的 JSON 选项（`baseURL`/`timeout`…） |
| `headers` / `body` | 追加请求头 / 合并进请求体 |
| `models` | 新增或覆盖模型（`modelID`、`name`、`limit`、`cost`、`capabilities`、`variants`、`disabled`…） |

常用 `package` 取值（V2 原生，`packages/core/src/aisdk-native.ts:54-123` + V2 Providers 文档）：

```
@opencode/ai/providers/openai              @opencode/ai/providers/openai/chat
@opencode/ai/providers/openai/responses    @opencode/ai/providers/openai-compatible
@opencode/ai/providers/openai-compatible/responses
@opencode/ai/providers/anthropic           @opencode/ai/providers/anthropic-compatible
@opencode/ai/providers/google              @opencode/ai/providers/google-vertex
@opencode/ai/providers/azure               @opencode/ai/providers/amazon-bedrock
@opencode/ai/providers/openrouter          @opencode/ai/providers/xai
```

也可以直接给 npm 包名（如 `@acme/opencode-provider`）或 `file://` 本地包路径。

### ⚠️ `aisdk:` 与 `@ai-sdk/*` 是旧写法

V1 的 `npm: "@ai-sdk/openai-compatible"` / 迁移后的 `package: "aisdk:@ai-sdk/openai-compatible"`
**不是 V2 的原生写法**，只是兼容入口：`AISDKNative.rewrite()`（`packages/core/src/aisdk-native.ts:19-52`）
会把它换算成对应的 `@opencode/ai/providers/*`（`@ai-sdk/openai-compatible` → `@opencode/ai/providers/openai-compatible`，
`aisdk:` 前缀由 `Provider.aisdk`/`isAISDK` 处理，`packages/core/src/provider.ts:24-34`）。
新配置请直接写 `@opencode/ai/providers/*`。

### V1 写法（legacy，会自动迁移）

V1 配置仍兼容：根键 `provider`（单数）+ `npm` + `options`。
`packages/core/src/config/normalize.ts:168-176` 会把 `provider` 迁移后与 `providers` 合并
（迁移函数 `packages/core/src/v1/config/migrate.ts:107-126`）。仅在维护老配置时使用。

### 凭据的三种形态（任选）

1. **`/connect` 手动填 key**：声明配置后 `/connect` 列表里出现（label「Manually enter API Key」），key 存服务端 SQLite（`opencode debug paths db`）。
2. **`env` 环境变量**：配 `"env": ["ACME_API_KEY"]`，OpenCode 从**服务端进程**读取（`opencode service set env ACME_API_KEY sk-...`）。
3. **直接写 key，不进 `/connect`**：`settings.apiKey`（支持 `{env:VAR}` 占位）。

## 路线 B：写插件注册（可自定义 OAuth / CLI 认证）

服务端插件上下文暴露 `ctx.integration`（V2 文档：<https://opencode.ai/v2/docs/build/plugins/> 的 Integrations 一节）。

Promise 插件（`@opencode/plugin`）：

```ts title=".opencode/plugins/acme/index.ts"
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "acme.provider",
  async setup(ctx) {
    await ctx.integration.transform((editor) => {
      editor.update("acme", (integration) => { integration.name = "Acme" })
      editor.method.update({ integrationID: "acme", method: { type: "key", label: "Paste API key" } })
      editor.method.update({ integrationID: "acme", method: { type: "env", names: ["ACME_API_KEY"] } })
      // 还能：{ id, type: "command", label, command: ["acme", "print-token"] }
      // 还能：{ id, type: "oauth", label } + authorize/refresh（Effect 版见下）
    })
    await ctx.integration.reload() // 外部状态变化后重放 transform
  },
})
```

Effect 插件（`@opencode/plugin/effect`）带 OAuth 回调：

```ts
yield* ctx.integration.transform((editor) => {
  editor.method.update({
    integrationID: "acme",
    method: { id: "device", type: "oauth", label: "Sign in with Acme" },
    authorize: () => Effect.succeed({
      mode: "code",
      url: "https://acme.example/device",
      instructions: "Enter the displayed code",
      callback: (code) => exchangeCode(code),
    }),
  })
})
```

method 四种：`key` / `env` / `command` / `oauth`。内置范例：`packages/core/src/plugin/provider/openai.ts`。

**限制**：`ctx.integration` 属**服务端**插件上下文。本仓库的插件是 **CLI/TUI 插件**（`@opencode/plugin/tui`），
其 ctx（`packages/plugin/src/tui/context.ts`）**没有** `integration` —— 走这条路线得再提供 server 侧插件入口。

## 路线 C：wellknown URL 发现（实验性，仅 CLI）

`opencode auth login <https-url>` 会把该 URL 当「认证发现源」拉取并持久化，之后集成出现在列表里：

- CLI：`packages/cli/src/commands/handlers/auth/login.ts:62-73`（`integration.wellknown.add`）
- 协议：`packages/protocol/src/groups/integration.ts:46`（`POST /api/experimental/integration/wellknown`）
- 存储：`packages/core/src/wellknown.ts:98`、`:147-155`（KV key `wellknown:sources`）
- TUI 的 `/connect` 对话框**没有**这个入口。

## 边界 / 坑

- 内置 provider 插件清单 `ProviderPlugins`（`packages/core/src/plugin/provider.ts:34-66`）与 models.dev 目录都**不可由用户直接扩展**——配置 + 插件两条路已覆盖「自定义供应商」。
- V2 的 `/connect` **没有** V1 文档里那个「Other → 手输 provider id」入口（全仓无该 integration）。
  V2 流程：**先声明配置** → `/connect` 里才出现 → 再填 key。
- 只存 key ≠ 能调用模型：还要 `package` + `settings.baseURL` + `models`。
- 选对协议：`/v1/chat/completions` → `@opencode/ai/providers/openai-compatible`（或 `.../openai/chat`）；
  `/v1/responses` → `.../openai/responses`；Anthropic 协议 → `.../anthropic`。混合可按模型覆盖 `models.<id>.package`。
- V2 已移除 `azure-cognitive-services` / `google-vertex-anthropic` 两个旧 provider ID。

## `/connect` 相关的 TTL / 有效期

`/connect` **命令本身是静态内置命令，无 TTL**（随 TUI 启动注册进命令表，`app.tsx:945-958`，永不自动失效）。
有 TTL 的是它触发的**连接流程**与它背后拉取的**模型目录**：

**模型目录（models.dev）的 TTL = 5 分钟**——`packages/core/src/models-dev.ts:319` 的 `const ttl = Duration.minutes(5)`：
- 数据源默认 `https://models.opencode.ai/api.json`（`:268`），不是直接打 `models.dev`；请求超时 10s、失败重试 2 次。
- 来源优先级：`options.file` → KV 缓存（key `models-dev:catalog`）→ **内置快照** `packages/core/src/models-dev/snapshot.txt` → 网络（`:374-390`）。
- 后台每 5 分钟轮询一次（`refresh().pipe(Effect.repeat(Schedule.spaced(ttl)))`，`:422`）。`Schedule.spaced` 语义是**先跑一次、之后每次完成再等 5 分钟**，不是固定墙钟节奏；跑在 **server 进程**（`packages/server/src/routes.ts:120` 把 `ModelsDev.node` 挂进 server，TUI 客户端只通过事件流接收更新）。`--get-yargs-completions` 或 `fetch: false`/`options.file` 时不轮询。单次请求 10s 超时、失败重试 2 次后忽略，轮询不中断。`refresh(force=true)` 可强制。
- 写缓存前若 `Date.now() - updatedAt < 5min` 则直接跳过（`:401`）；若响应体逐字节相同则跳过写缓存/失效/事件（`:407`），避免下游抖动。
- 内容变化时会发 `ModelsDev.Event.Refreshed` → `ModelsDevPlugin` 触发 `ctx.integration.reload()` + `ctx.provider.reload()`（`packages/core/src/plugin/models-dev.ts:60-72`），使 `/connect` 列表与 `/models` **运行时原地刷新**（无需重启）。

其余连接相关 TTL：

| 对象 | 有效期 | 依据 |
|---|---|---|
| `/connect` 命令本身 | 无（静态注册，不过期） | `packages/tui/src/app.tsx:945` |
| OAuth 连接尝试 attempt | 10 分钟（授权返回 `expiresAt` 时以其为准） | `packages/core/src/integration.ts:237,580` |
| command 连接尝试 attempt | 10 分钟 | `packages/core/src/integration.ts:239,626` |
| attempt 终态（complete/failed/expired）保留 | 1 分钟 | `packages/core/src/integration.ts:238` |
| attempt 过期扫描周期 | 30 秒 | `packages/core/src/integration.ts:239` |
| connection status（运行时告警） | 不持久化（进程内 Map） | `packages/core/src/integration.ts:289-292` |
| API key 凭据 | 永不过期 | `packages/schema/src/credential.ts:42-47` |
| OAuth 凭据 | 到其 `expires`；`resolve` 时距过期 < 5 分钟自动 refresh | `packages/core/src/integration.ts:696-713` |
| 配对码 `/pair`（另一条链路） | 5 分钟、一次性 | `packages/server/src/pairing.ts:7` |
| wellknown 源 | 持久化在 KV `wellknown:sources`，需显式 refresh | `packages/core/src/wellknown.ts:98,127` |

## 附带：用插件「免写 models」的思路

opencode.json 的模型列表膨胀问题，可用 **server 侧插件**在运行期注册 provider/models 解决（`ctx.provider.transform`），
配置文件里只留几行 `providers.<id>`。关键前提：**同一个插件目录可同时提供 server 与 TUI 入口**
（`packages/plugin/src/host.ts:43` 解析 `server`/`index` + `tui` + `rpc` 三个 entrypoint），
即目录内放 `index.ts`（server）+ `tui.tsx`（TUI）即可。

- 若供应商在 models.dev：**零模型配置**（目录插件自动带模型）。
- Ollama / LM Studio / vLLM / Azure：opencode 内置动态发现，也不用列模型。
- 其他网关/自建：插件注册（可从 models.dev 或供应商 `/v1/models` 拉取后 `editor.add`）。

## 参考

- V2 Config：<https://opencode.ai/v2/docs/config/>
- V2 Providers：<https://opencode.ai/v2/docs/providers/>
- V2 CLI Providers（`/connect`、`auth login`、methods、env）：<https://opencode.ai/v2/docs/cli/providers/>
- V2 Plugins：<https://opencode.ai/v2/docs/build/plugins/> 、Effect 版 <https://opencode.ai/v2/docs/build/plugins/effect/>
