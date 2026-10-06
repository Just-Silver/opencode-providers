# 零 opencode.json：用插件把供应商+模型全在运行期注册

目标：**完全不写 `opencode.json`**，插件安装好即用，`/connect` 里能连、`/models` 里能选。

结论：**可行**。供应商与集成（integration）都可以由插件在运行期注册，凭据走 `/connect` 存进服务端 SQLite。
`opencode.json` 可以一个字段都不写。

> 源码：`E:\Code\Projects\Agent\Externals\opencode`，v2.0.23（commit `e2d540042a`）。
> 文档：<https://opencode.ai/v2/docs/build/plugins/>（Providers / Integrations 两节）。

## 为什么不需要配置（证据链）

1. 插件可以注册 provider：`ctx.provider.transform((editor) => editor.add({ info, models }))`
   （`packages/plugin/src/effect/provider.ts` 的 `ProviderEditor.add`；V2 文档 Providers 一节）。
2. 插件可以注册 integration 与认证方法：
   `ctx.integration.transform((editor) => editor.method.update({ integrationID, method: { type: "key" } }))`
   （`packages/plugin/src/effect/integration.ts:78-88`）。
3. `/connect` 的列表来自服务端 `integration.list()`，**不读配置文件**（`packages/tui/src/component/dialog-integration.tsx:84`）。
   用户填的 key 存进服务端 SQLite 凭据表（按 integrationID 归属）。
4. 请求时凭据自动注入 provider，**也不需要配置**：
   `resolveModel` → `provider.integrationID ?? providerID` → `integrations.connection.active(id)` → `connection.resolve(...)`
   → `nativeCredentialSettings(package, credential)` → `{ apiKey: credential.key }`
   （`packages/core/src/model-resolver.ts:364-369`、`:308-318`）。
5. provider 可用性：`activation === "enabled"` 时**无需连接也可见**（`packages/core/src/provider.ts:392-405`）；
   内置/配置供应商同样用 `enabled`。

## 两个硬前提

### 1. 必须是 **server 侧插件**（TUI 插件没有这些域）

`ctx.provider` / `ctx.integration` 只在服务端插件上下文里（`packages/plugin/src/effect/plugin.ts:37,43`）。
TUI 插件（`@opencode/plugin/tui`）的 ctx 没有它们（`packages/plugin/src/tui/context.ts`）。

**但同一个插件目录可以同时提供两个入口**：`packages/plugin/src/host.ts:43`

```ts
return { server: entry(["server", ""]), tui: entry(["tui"]), rpc: entry(["rpc"]) }
```

即在现有目录 `~/.config/opencode/plugins/opencode-tui-usage/` 里加一个 `index.ts`（server 入口），与 `tui.tsx` 并存即可。

### 2. 仍然是「安装插件」而不是「改配置」

插件从 `plugin/` 或 `plugins/` 目录**自动发现**，无需在 `opencode.json` 里登记
（`packages/core/src/config/plugin/source.ts:122-133` 扫目录；`:164-172` 解析目录插件的 server entrypoint）。
所以：**插件文件放磁盘上 → 生效，opencode.json 不动**。

## 最小骨架

```ts
// ~/.config/opencode/plugins/opencode-tui-usage/index.ts
// server 入口（与同目录 tui.tsx 并存）；不写 opencode.json
import { Model, Plugin, Provider } from "@opencode/plugin"

const PROVIDER_ID = "acme"
const INTEGRATION_ID = "acme" // 与 provider.integrationID 一致，凭据才能注入

export default Plugin.define({
  id: "opencode-tui-usage.providers",
  async setup(ctx) {
    // 1) 注册认证方法 → 出现在 /connect
    await ctx.integration.transform((editor) => {
      editor.update(INTEGRATION_ID, (integration) => { integration.name = "Acme" })
      editor.method.update({ integrationID: INTEGRATION_ID, method: { type: "key", label: "Paste API key" } })
      // env 方法仅为无交互/CI 场景的可选项；只想走 /connect + DB 就别加（见「凭据存哪」一节）
    })

    // 2) 拉模型清单（任选来源：models.dev / 供应商 /v1/models / 本地文件）
    const models = (await fetch("https://llm.acme.example/v1/models").then((r) => r.json())).data.map(
      (m: { id: string }) => ({ ...Model.Info.default(Provider.ID.make(PROVIDER_ID), Model.ID.make(m.id)), name: m.id }),
    )

    // 3) 注册 provider + 模型（运行期，不落盘）
    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(Provider.ID.make(PROVIDER_ID)),
          name: "Acme",
          activation: "enabled",
          integrationID: INTEGRATION_ID as any, // Integration.ID
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: "https://llm.acme.example/v1" },
        },
        models,
      })
    })
  },
})
```

Effect 版写法见 <https://opencode.ai/v2/docs/build/plugins/effect/>（`Plugin.define({ id, effect })` + `yield*`）。

## 运行时行为

- **配置为 0**：provider/integration/models 全部由插件在 server 启动时注册；`opencode.json` 无需任何字段。
- **凭据持久**：`/connect` 填的 key 存服务端 SQLite（`opencode debug paths db`），重启后仍在。
- **每 5 分钟可自刷新**：插件里 `setInterval` 重新拉模型 → `ctx.provider.reload()`（transform 需可重放）。
- **不膨胀**：模型清单只在内存 registry，不写配置文件。
- **卸载干净**：删插件目录即回到出厂状态（凭据仍在 DB，可用 `/connect` 管理）。

## 模型参数（模型元数据）从哪来

`Model.Info` 的完整字段见 `packages/schema/src/model.ts:118-142`。真正影响行为的只有一小撮：

| 字段 | 作用 | 缺失后果 |
|---|---|---|
| `limit.context` / `limit.output` | 上下文预算、压缩、超限判断 | 用 `Model.Info.default()` 的 200k/32k，可能不准 |
| `capabilities.tools` | 是否允许工具调用 | 默认 true；不支持工具时应显式设 false |
| `capabilities.input` / `output` | 图片/音频等模态 | 默认 `text+image` / `text` |
| `cost` | 成本显示与预算 | 默认全 0 |
| `compatibility` | reasoning 字段、maxTokens 字段等 | 默认空 |
| `variants` | effort/thinking 档位 | 默认空 |
| `name` / `family` / `time.released` / `status` | 纯展示 | id 兜底 |

三档来源，按优先级合并（高覆盖低）：

1. **远端目录（推荐底稿）**：OpenCode 用的是 `https://models.opencode.ai/api.json`（`packages/core/src/models-dev.ts:268`），
   字段：`id,name,family,release_date,attachment,reasoning,temperature,tool_call,cost,limit,modalities,status`（`:31-73`）。
   **插件拿不到内核的 `ModelsDev.Service`**（V2 插件 Context 无此域），需自己 `fetch`；失败可回退 `https://models.dev/api.json`。
2. **别名/覆盖表（自己维护）**：处理「新模型 ID 与目录不同名」。
3. **`Model.Info.default(providerID, id)` 兜底**：context 200k / output 32k / tools true / input text+image / cost 0
   （`packages/schema/src/model.ts:146-159`）。

> 前提澄清：本方案针对的正是**目录里没有的供应商**。这种供应商在 `api.json` 里没有条目，
> 所以 `api.json` **无法**告诉你「它支持哪些模型」，最多只能当**可选参数模板**（同 ID 的公共模型拿 limit/cost 参考），
> 甚至完全不用。权威清单必须来自供应商自己或你自维护。

### api.json 是「生成产物」：源头不重复，产出才重复

models.dev 的源数据是 TOML，**模型无关元数据只写一份**，provider 侧靠 `base_model` 继承 + 只写差异
（来源：models.dev README，仓库 `anomalyco/models.dev`，分支 `dev`）：

- `models/<lab>/<model>.toml` —— 供应商无关事实（name/family/dates/attachment/reasoning/tool_call/`limit` 默认/`modalities` 默认…）
- `providers/<provider>/models/<model>.toml` —— 该供应商的**服务细节/覆盖**（`cost`、不同的 `limit`、`interleaved`、`reasoning_options`、`status`…）
- 继承写法：
  ```toml
  base_model = "openai/gpt-5"   # 指向 models/ 里的 canonical
  [cost]
  input = 1.25
  output = 10.00
  ```
  「Override-only」：`base_model` 之后只写**与 base 不同**的字段；`base_model_omit = ["limit.input"]` 可移除继承字段。
- 生成时 **provider 字段覆盖 model 字段**；因此同一模型在不同 provider 下 limit/cost 可以不同。
- 生成 `api.json`/`catalog.json` 时，用 `base_model` 的 provider 会带上 `canonical_model_id`，让消费者能把
  某个 provider 的模型 ID 归因到「来源 lab/模型」，而不用靠名字猜。

发布端点也体现了这个分层：

| 端点 | 内容 |
|---|---|
| `api.json` | provider 端点 + 各 provider 的模型（**已扁平化**，同一模型多 provider 各一份） |
| `models.json` | **仅**模型无关元数据（一份） |
| `catalog.json` | 上面两者合并 |

所以：**api.json 里是重复的（生成产物），源头不重复（`base_model` 继承）。**

> 对我们的自维护 JSON 的启示：若要放多家供应商，就模仿**源头**那层（共享 `models` 表 + provider 写 `base` 引用 + 覆盖），
> 别模仿扁平的 api.json；只有一家供应商时扁平结构就够，别过度设计。

### 实测：同一模型在 api.json 里到底重复多少份

用仓库内置快照 `packages/core/src/models-dev/snapshot.txt` 统计（226 个 provider、8390 条 provider×model 条目）：

| 指标 | 值 |
|---|---|
| 条目总数 | 8390 |
| 去重后的模型 ID 数 | 3917 |
| 出现在 >1 个 provider 的 ID 数 | 1150 |
| 带 `canonical_model_id` 的条目 | 5319 |

以 `DeepSeek-V4.1-Flash` 为例：

| 数法 | 结果 |
|---|---|
| 精确 ID `deepseek-ai/DeepSeek-V4.1-Flash` | 6 条 |
| 精确 ID `deepseek-v4.1-flash` | 20 条 |
| `canonical_model_id == "deepseek/deepseek-v4.1-flash"` | **83 条 / 57 个 provider / 41 个不同的本地 ID** |
| 其中本地 ID 与 canonical 完全同名的 | 仅 10 条 |

结论：**重复是真的（同一模型 83 份），但按某个 ID 字符串去数根本数不出来** —— 各 relay 用的是自己的
ID（`deepseek/deepseek-v4.1-flash`、`accounts/fireworks/models/deepseek-v4p1-flash`、`TEE/...`、`hf:...`、
`umans-deepseek-v4.1-flash`、`deepseek-v4-flash`…）。唯一的连接键就是 `canonical_model_id`。
`models.json` 端点是它的「去重视图」（每模型一份），`api.json` 是「按 provider 展开视图」。

> 对自维护 JSON 的直接启示：**别用 ID 字符串做关联键**，必须像 models.dev 一样显式写 `base`/`canonical` 指针。

### 「供应商支持哪些模型」官方怎么界定

`api.json`（快照同形）是**按供应商分桶**的：顶层 key = provider id，每个 provider 自带 `models` 映射
（`{"deepinfra":{...,"models":{"tencent/Hy3":{...}}}, "alibaba":{...,"models":{...}}}`）。
所以：

- **不存在全局模型池，也不做跨供应商合并**。OpenCode 就是把 `input[providerId].models` 原样注册到该 provider 下
  （`packages/core/src/models-dev.ts:86-120` 的 `normalize()`）。即「该供应商支持哪些模型」= 目录里该 provider 的 `models` 子集，
  由模型目录维护，不是 OpenCode 推断的。
- 同一个模型会在多个 provider 下各有一条（各自独立的 limit/cost/modalities），例如 `alibaba/qwen3.7-max`。
- models.dev 数据里有 `canonical_model_id`（跨供应商的同一模型标识，如 `"canonical_model_id":"tencent/hy3"`），
  但 **OpenCode 不消费它**（全仓仅出现在 `packages/core/src/models-dev/snapshot.txt`）。别指望它做自动对齐。
- 对**目录里没有的自定义 provider**，目录自然没有它的支持清单 → 只能：
  1. `providers.<id>.canonical` + `models.<alias>.modelID` 声明「我像谁、哪个是哪个」（`config/plugin/provider.ts:59,75-88`，仅覆盖你声明的模型）；
  2. 问供应商自己（`/v1/models` 等，见下「动态发现」）；
  3. 自己维护清单。
  注意 `canonical` 在运行期的真正作用是**选择原生运行时包/协议**（`aisdk-native.ts:36`、`aisdk.ts:124,371` 把它当 provider 身份），
  不是自动继承整张模型表。

### 「ID 不同名」怎么匹配

OpenCode 内部已有两种现成做法，可直接照抄：

- **`base_model_id` / `hugging_face_id` 匹配模板**：内置 Modal 插件 `packages/core/src/modal/models.ts:74-83`
  用 `templates.get(item.base_model_id ?? item.hugging_face_id ?? item.id)` 把远端模型与既有模板对上，
  再 `build()` 逐字段「远端优先、模板兜底、默认兜底」。
- **别名继承（配置层）**：`providers.<id>.canonical`（继承哪个内置供应商目录）+ `models.<alias>.modelID`，
  会在 `packages/core/src/config/plugin/provider.ts:75-88` 用 `source.models.get(config.modelID ?? id)` 克隆参数。
  —— 这正是「ID 不同名也能继承目录参数」的官方机制；插件里复刻同一逻辑即可（不写配置）。

插件里的实用匹配顺序建议：`精确 ID` → `别名字典` → `base/hf id` → `family 前缀` → `default()`。

### 维护在哪（都不在 opencode.json）

| 位置 | 特点 | 何时用 |
|---|---|---|
| 插件源码常量 | 零网络零 TTL，改参数要发版 | 稳定、少量供应商 |
| 插件自己的数据目录 | 可读写、可手工编辑、卸载即清。本仓库已有 `shared/paths.ts` 的 `pluginDataDir()`（Win `%LOCALAPPDATA%\opencode-tui-usage\`） | 缓存目录/别名表/本地覆盖 |
| 远端拉取 | 自动跟新，需缓存+TTL+失败回退 | models.dev、供应商 `/v1/models` |

> 注意：TUI 入口与 server 入口是**两个进程**，但同一台机同一用户，数据目录路径一致，可共用同一份缓存文件。

### 拉取 TTL 参考（官方既有数值）

| 来源 | OpenCode 现值 | 依据 |
|---|---|---|
| models.dev 目录 | **5 分钟**轮询 + KV 缓存(`updatedAt`) + 内置快照兜底 | `packages/core/src/models-dev.ts:319,392,401,422` |
| Ollama / LM Studio / vLLM 本地发现 | **30 秒**（可配） | `plugin/provider/ollama.ts:55,181`、`lmstudio.ts:33,125`、`vllm.ts:22,110` |
| DigitalOcean 模型列表 | **5 分钟** | `plugin/provider/digitalocean.ts:178` |
| ChatGPT / Copilot 模型列表 | **15 分钟** | `plugin/provider/chatgpt.ts:339`（`Duration.minutes(15)`） |
| 本插件现有更新检查 | 成功 24h / 失败冷却 1h | 本仓库 `update/index.ts` |

建议：远端目录取 **15–60 分钟**（目录变化很慢；不必跟着内核 5 分钟）；本地运行时 30 秒；失败保留上次清单 + 冷却。

缓存三个必须遵守的点（都是官方踩过的坑）：
- **内容没变不要 `provider.reload()`**：用 `updatedAt` + 内容 digest 判重（`models-dev.ts:401-411`），否则 `/models` 抖动。
- **失败保留上次清单**，不要清空（`ollama.ts:112-117` 的 `cached` 逻辑）。
- **冷启动兜底**：自带一份精简兜底清单（内核是打包 `packages/core/src/models-dev/snapshot.txt`）。

## 凭据存哪 / 怎么注入（不需要插件动手）

**存储**：opencode 的 SQLite 表 `credential`（`packages/core/src/credential/sql.ts:5-14`），
DB 在数据目录（`opencode debug paths db`，通常 `~/.local/share/opencode/opencode.db`）。
字段：`id`(`cred_*`)、`integration_id`、`label`、`value`(JSON)、`active`、时间戳。

- `value` 形态：key 凭据 `{type:"key", key:"sk-..."}`；OAuth 凭据 `{type:"oauth", refresh, access, expires, methodID}`（`schema/src/credential.ts:31-47`）。
- **明文 JSON 存 SQLite，未加密**（别把 key 写进日志/文档）。
- 每个 integration 同时只有一条 `active=true`；新建默认激活并把旧条目置 false（`credential.ts:121-141`）。
- **env 不落盘**：运行时读服务端进程的 `process.env[name]`（`integration.ts:378-382`），不是 account。
  且 env **不是交互方式**：`/connect` 与 `auth login` 都把 `type === "env"` 过滤掉
  （`packages/tui/src/component/dialog-integration.tsx:58-62`、`packages/cli/src/commands/handlers/auth/shared.ts:50`），
  只在服务端进程恰好有该变量时作为 connection 静默生效（`auth list` 里 type=environment）。

**写入**：`/connect` 填 key → 服务端 `integration.connection.key()`（`integration.ts:715-738`）→ `Credential.create`。
插件也可编程写入：`ctx.integration.connect.key({ integrationID, key })`（V2 插件 API）。

**注入（关键：插件完全不参与）**：发模型请求时
`resolveModel` → `providers.get(providerID)` → `integrations.connection.active(provider.integrationID ?? providerID)`
→ `connection.resolve(connection)` → `nativeCredentialSettings(package, credential)`
（`packages/core/src/model-resolver.ts:364-369`、`:308-318`）：

| credential | 注入到 |
|---|---|
| `type:"key"` | `{ apiKey: credential.key }` |
| OAuth + `anthropic`/`anthropic-compatible` | `{ authToken: credential.access }` |
| OAuth + `google-vertex*` | `{ accessToken: credential.access }` |
| OAuth + 其他 | `{ apiKey: credential.access }` |

`connection.active` = `resolveConnections()` 的第一条 = **最新一条已存凭据**，没有才回退 env（`integration.ts:369-383, 692-694`）。
OAuth 在 `resolve` 时若距 `expires` 不足 5 分钟会自动 refresh（`:696-714`）。

→ 插件的唯一义务：**保证 `provider.integrationID === integration.id`**（否则 `:366` 找不到凭据）。

## 待定：多 provider 共享注册表（设计进行中）

- 注册表：GitHub raw 托管，仿 models.dev **源头**结构（共享 `models` 表 + provider `base` 引用 + 覆盖），多家供应商共享。
- 参数：全部自维护（不推断）；`/v1/models` 只用作模型 **id 清单**。
- 未决：插件如何决定注册/激活哪些 provider（见下）。

### 激活语义（官方依据 `packages/core/src/provider.ts:392-405`）

| provider.activation | 可用条件 |
|---|---|
| `"disabled"` | 永不可用 |
| `"enabled"` | **总是**出现在 `/models`（没凭据也能选，调用才失败） |
| `"auto"` | 有连接（已存 key 或检测到 env）才可用；`integrationID` 存在时无连接则不可见 |

→ 多 provider 注册表天然应对：全部注册 + `activation: "auto"` + `integration(key)`（只想走 /connect + DB 就**不要**加 env 方法），
`/connect` 里能看到全部，`/models` 只出现「用户真配了凭据」的那些。

### 插件放哪（待选）

注册表插件**只需要 server 入口**（目录里 `index.ts`，或 `plugins/` 下直接一个 `.ts` 文件即可，不需要 `tui.tsx`）。

| 选项 | 形态 | 代价 |
|---|---|---|
| A | 加进现有 `opencode-tui-usage/` 目录（加 `index.ts`） | 复用现有安装/发版/一键更新；但一个插件混两个职责，用户为装注册表也得装用量侧边栏 |
| B | 独立仓库 | 职责单一；要重建安装/发版/更新 |
| C1 | **新仓库**同时放注册表 JSON + 插件代码 | 注册表本就要 GitHub raw；同版本演进；不污染现有插件；新仓库需自建 release/安装 |
| C2 | 当前仓库新建插件目录 + 注册表文件 | 省一个仓库；但当前仓库定位是「单 TUI 插件仓库」，会变多插件仓库，install/update/发版都要改 |

## 坑 / 注意

- `integrationID` 必须与 provider 的 `integrationID` 一致，否则凭据不会注入（`model-resolver.ts:366`）。
- provider 默认 `activation: "auto"`：无连接时不可见；想先选模型后连凭据就设 `"enabled"`。
- `package` 用 V2 原生 `@opencode/ai/providers/*`，别用 `aisdk:`/`@ai-sdk/*`（旧写法，会被 rewrite）。
- 模型清单来源要稳定：供应商 `/v1/models` 字段各家不同，可能要映射成 `Model.Info`（参考 `packages/core/src/modal/models.ts:96-151` 的 `build()` 合并写法）。
- server 插件在**后台服务进程**里跑；改完插件需重启服务（`opencode service restart`）或让发现器重载。
- 若供应商在 models.dev 目录里，其实连 provider/models 都不用注册，只需注册一个带 key 的 integration。
