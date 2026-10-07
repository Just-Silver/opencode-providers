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

### 拉取 TTL 参考（官方既有数值，2026-10-07 复核）

| 来源 | OpenCode 现值 | 拉取方式 | 依据 |
|---|---|---|---|
| models.dev 目录（`<source>/api.json`） | **5 分钟** | **后台轮询** + KV 缓存(`updatedAt`+`digest`) + 内置快照兜底；10s 超时、瞬时错误退避重试 2 次 | `packages/core/src/models-dev.ts:330,345-352,385-401,412,433` |
| Ollama / LM Studio / vLLM 本地发现 | **30 秒**（可配） | 后台轮询 + 内存 `checked` 判新 | `plugin/provider/local.ts:34,89,116`（ollama/lmstudio/vllm 都经它） |
| DigitalOcean 模型列表 | **5 分钟** | 后台轮询 | `plugin/provider/digitalocean.ts:178` |
| 插件版本检查（npm） | **24 小时** | 插件激活时 `check(target)`，可 `refresh:true` 强查 | `plugin/update.ts:9,39` |
| ChatGPT 模型列表 | 15 分钟 | **已注释掉**（现在无轮询） | `plugin/provider/chatgpt.ts:345`（注释行） |

**内核与本插件的机制差别（关键）**：

| | opencode 内核（models.dev / 本地发现） | 本插件（注册表） |
|---|---|---|
| 触发 | **常驻定时轮询**（`Schedule.spaced(ttl)`），没人用也会醒 | **只在插件激活时判一次**，没有定时器 |
| "TTL" 语义 | 轮询周期 **且** 缓存陈旧阈值（`updatedAt`/`checked`） | 只是**激活时刻**的陈旧阈值 |
| 启动是否阻塞网络 | 不：文件 → KV ⇒ **打包快照** → 网络；有快照就永不请求 | 会：无缓存且拉不到 ⇒ setup `return`（0 条注册） |
| 内容判重 | 响应体 **sha256 digest**（相同则连缓存都不写） | HTTP **`ETag`**（304 时用旧 body 并把 `fetchedAt` 顺延） |
| 缓存位置 | 全局 KV（`kv` 表） | 同一个全局 KV（`plugin:<id>:registry-cache:<url>`） |

建议：远端目录取 **15–60 分钟**（目录变化很慢；不必跟着内核 5 分钟）；本地运行时 30 秒；失败保留上次清单 + 冷却。

缓存三个必须遵守的点（都是官方踩过的坑）：
- **内容没变不要 `provider.reload()`**：用 `updatedAt` + 内容 digest 判重（`models-dev.ts:401-411`），否则 `/models` 抖动。
- **失败保留上次清单**，不要清空（`ollama.ts:112-117` 的 `cached` 逻辑）。
- **冷启动兜底**：自带一份精简兜底清单（内核是打包 `packages/core/src/models-dev/snapshot.txt`）。

### 本插件的注册表缓存：位置 / TTL / 何时重拉（实测）

**位置**：opencode 的全局 SQLite 表 `kv`，文件 `~/.local/share/opencode/opencode.db`（`opencode debug paths db`）。
插件通过 `ctx.storage` 读写，宿主机把键加上命名空间前缀 `plugin:<插件 id 每个字符的 utf-16 hex>:`
（`packages/core/src/plugin/host.ts:602-628`；跨 location 共享，TUI/server 两个进程读同一行）。

- 键名 = `plugin:…:registry-cache:<注册表 URL>` → **每个 URL 一份缓存**；换 URL 等价于无缓存 = 立刻重拉
  （这是故意设计，见 `plugin/opencode-providers/index.ts:62-63`）
- 值 = `{ etag, fetchedAt, body }`（`registry/source.ts:19-23`），`body` 是**原始 JSON 文本**（不是解析结果）

**TTL = 6 小时**（`registry/source.ts:16` `DEFAULT_TTL_MS = 6 * 60 * 60 * 1000`；HTTP 超时 10s `:17`）。

> **关键：没有后台定时器。** `loadRegistry()` 只在插件 `setup()` 时执行一次 —— 所谓"重拉"发生在**插件被(重新)加载**
> 的时刻：opencode 启动、插件安装/换版本、配置变化（文件监视热重载）、显式重启服务。
> 6h 是「加载那一刻判断缓存是否太旧」的阈值，不是轮询周期；没重启就一直用手里那份（进程内已注册的也不变）。
>
> **每次启动 ≠ 每次重拉**：缓存行在全局 `kv` 表里**跨进程/跨启动持久**，所以 6h 内无论启动多少次都**零网络**。
> 实测（`loadRegistry` + 真实缓存行 + 计数 fetch）：默认 TTL 下 `source = "cache"`、**fetch 调用 0 次**；
> 把 TTL 压到 1ms 才 `source = "network"`、调用 1 次；过期后服务端回 304 则仍是 `cache`（调用 1 次但**不下 body**，
> 并把 `fetchedAt` 顺延再管 6h）。

**谁来拉**：只有 **server 入口**（`index.ts`）读注册表 —— 即承载它的 **service 常驻进程**。TUI 入口（`tui.ts`）
**完全不读注册表**（只注册 `/connect-providers`，命令里通过 `ctx.data.location.integration.list()` 读服务端**已注册**的
integration，见 `view/connect.ts:113-117`），CLI/其它客户端同理 —— 所以**开多少次 TUI 都不会多拉一次**。
缓存行在全局 `kv` 表（跨 location、跨进程），多个触发并发时最多"几乎同时发两条"，同样无害。

另一次实测（2026-10-07，本机）：service 进程 `StartTime = 05:53` 本地，而缓存行 `fetchedAt = 07:40` 本地
（**晚了 1h47m**，因为期间发生过插件重载）→ 证明**"启动"不是唯一触发点**，重载也会走一次 `setup()`；
而随后 08:07 那次重载（换成 npm `0.1.0` 的新代）**没有重写缓存行** → TTL 内零网络。两个方向都钉住了。

`loadRegistry` 里**不直接返回缓存、而去发网络请求**的情况，只有这几种：

| 条件 | 结果 |
|---|---|
| ① 没有缓存（首次安装 / 换 URL / 手工删了那行） | 走网络 |
| ② 缓存 `fetchedAt` 距今 ≥ 6h | 走网络 |
| ③ 缓存 body 解析失败（JSON 坏 / `schemaVersion` 不匹配或字段不合法） | 走网络（别用坏数据） |
| ④ 缓存新鲜 | **零网络**，直接用（`source: "cache"`） |

网络请求的结果分支（都实测过）：

- `200` → 写新 `etag`+`fetchedAt`+`body`，`source: "network"`；
- `304` → 用缓存 body，但**顺延 `fetchedAt` 再管 6h**（所以服务端没改内容时永不重下）
- 非 2xx / 超时 / 网络错误 → **沿用旧缓存**（`source: "stale-cache"`，并 warn 一句）；**一条缓存都没有**时 setup
  只 `console.error` 后 `return` → 插件 `active` 但注册 **0 条**（见上文）
- 200 但 body 解析失败 → 同上先试旧缓存

**想立刻重拉**（不等 6h/不重启）任选其一：重启 `opencode service restart`；把 `registryUrl` 换成新地址（键不同）；
或直接删掉对应 kv 行。**注意注册表数据改动本身是 URL 不变的**，所以不会自动跳过 TTL。

**观测**：`console.*` 不进日志（上文），直接读 DB 最准（Node ≥ 22.5 自带 `node:sqlite`，只读打开）：

```bash
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.USERPROFILE+'\\.local\\share\\opencode\\opencode.db',{readOnly:true});const ns='plugin:'+[...'opencode-providers'].map(c=>c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+':';for(const r of db.prepare('SELECT key,value FROM kv WHERE key LIKE ?').all(ns+'%')){const v=JSON.parse(r.value);console.log(r.key.slice(ns.length),'|',new Date(v.fetchedAt).toISOString(),'|',v.etag)}"
```

本机实测（2026-10-07，**清理后**）只剩当前生效的那一条：

```
registry-cache:https://raw.githubusercontent.com/Just-Silver/opencode-providers/main/registry/registry.json | 2026-10-06T23:40:55.419Z | W/"8638..."
```

曾存在、已清掉的两条死行（`DELETE FROM kv WHERE key = ?`，`changes=1` 各一条）：

- `registry-cache`（**无 URL 后缀**）= 早期版本（键里还没有 URL 那版）留下的，0.1.0 只读带 URL 的键，永不再用；
- `registry-cache:http://127.0.0.1:45999/registry.json` = 「探针注册表法」（见下节）留下的缓存行，同样不会被读。

> 教训：探针法**只清源码不够**，拉取过的 URL 会在 `kv` 里留一条永久行；收尾必须按 key 删掉（见下节第 5 步）。
> 写库要有进程在跑时做，单条 `DELETE` 很安全，但别做批量改写。日常观测一律用上面的只读命令。

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

## 模型列表怎么进 `/model`（缓存 → 注册 → 过滤 → 暴露）

四层，前两层是本插件的，后两层是内核的：

| 层 | 谁做 | 干什么 | 出处 |
|---|---|---|---|
| ① 缓存 | 插件（`setup()` 时） | 注册表 JSON 原文存进**全局 `kv` 表**；键 `plugin:<插件 id 每字符 utf-16 hex>:registry-cache:<url>`，值 `{etag, fetchedAt, body}` | `registry/source.ts`、`plugin/host.ts:602-628`（前缀由宿主加） |
| ② 注册 | 插件（`setup()` 时） | 解析 body → `buildProviderModels()` → `ctx.provider.transform(editor => editor.add({ info, models }))`，**一次性写进 `Provider.Service` 的内存 records**（provider + 它的 models map） | `plugin/opencode-providers/index.ts:106-124` → `plugin/host.ts:202-226` |
| ③ 过滤 | 内核 | `Provider.snapshot()`：`activation:"disabled"` 剔除；`"enabled"` 直接进；**`"auto"` 要求该 integration 有 connection（凭据）** | `core/src/provider.ts:388-406` |
| ④ 暴露 | 内核 | `Model.read()`：`all` → `available = all.filter(m => m.enabled)`；`/api/model` 就是 `models.available()` | `core/src/model.ts:218-221,259`、`server/src/handlers/model.ts:10-16` |

- **TUI / 网页的模型选择器读同一个接口**：`component/dialog-model.tsx:25` → `data.location.model.list()` → 客户端 API `model.list` → `/api/model`。
- `enabled` 来自注册表的 `disabled` 字段（本仓 `registry/models.ts:77`）——所以注册表能"登记但不出现在 `/model`"。
- **变更通知**：Provider 变更 → `Provider.Event.Updated` → 重算 → `Model.Event.Updated`（`core/src/model.ts:236-251`）→ 客户端刷新。粘上 key 后模型"立刻"出现的两条原因：③ 每次快照都重算 + ④ 的事件推送。
- **注意**：模型列表是 ② 那一份**内存快照**，**不是**每次读 `kv`。kv 只是 ① 的缓存：注册表内容改了要等 TTL/重载（见「本插件的注册表缓存」节）才重新注册；而**凭据变化是立即生效**（③ 每次快照重算 availability）。

**和内核 models.dev 是同一张表吗**：是同一个 `kv` 表（同一个 `opencode.db`），只是键与值形态不同 ——

| 内容 | 键 | 值 | 谁写 |
|---|---|---|---|
| models.dev 目录（内核） | `models-dev:catalog`（自定义源为 `models-dev:catalog:<fast hash>`） | `{updatedAt, digest, body}` | core 的 models-dev 服务 |
| 本插件注册表 | `plugin:<id 的 hex>:registry-cache:<url>` | `{etag, fetchedAt, body}` | 插件（经 `ctx.storage`，前缀由宿主加） |

两者跨 location 共享、互不冲突（键空间不同）；本插件那一份的 TTL/重拉语义见上一节。

## 设计定案（0.1.0 起已实现）

- 注册表：GitHub raw 托管（`registry/registry.json` + `registry.schema.json`），仿 models.dev **源头**结构
  （共享 `models` 表 + provider `base` 引用/覆盖），多家供应商共享。
- 参数：全部自维护（不推断）；**不调**供应商 `/v1/models`。
- 注册/激活：注册表里每家都注册 + `activation: "auto"` + integration 只声明 `key`（决策依据见下）。

### 激活语义（官方依据 `packages/core/src/provider.ts:393-406`）

| provider.activation | 可用条件 |
|---|---|
| `"disabled"` | 永不可用 |
| `"enabled"` | **总是**出现在 `/models`（没凭据也能选，调用才失败） |
| `"auto"` | 有连接（已存 key 或检测到 env）才可用；`integrationID` 存在时无连接则不可见 |

→ 多 provider 注册表天然应对：全部注册 + `activation: "auto"` + `integration(key)`（只想走 /connect + DB 就**不要**加 env 方法），
`/connect` 里能看到全部，`/models` 只出现「用户真配了凭据」的那些。

### 落地形态（已定案）

**独立仓库、插件 + 注册表同仓**（当时候选 C1；本仓库实际形态）：

- 源码在 `plugin/opencode-providers/`（**不放** `.opencode/plugins/`，否则仓库自身成为发现根、与全局安装同 id 相撞）；
- 注册表在 `registry/registry.json`（+ `registry.schema.json`），GitHub raw 直供；
- 根 `package.json` 是 npm 包形态（`exports{./server,./tui}`），既能 `"plugins": ["@justsilver/opencode-providers"]` 配置安装，
  也能用 `install.sh` / `install.ps1` 脚本安装；
- 目录内双入口：`index.ts`（server，拉注册表并注册）+ `tui.ts`（只注册 `/connect-providers`，不读注册表）。

## 坑 / 注意

- `integrationID` 必须与 provider 的 `integrationID` 一致，否则凭据不会注入（`model-resolver.ts:366`）。
- provider 默认 `activation: "auto"`：无连接时不可见；想先选模型后连凭据就设 `"enabled"`。
- `package` 用 V2 原生 `@opencode/ai/providers/*`，别用 `aisdk:`/`@ai-sdk/*`（旧写法，会被 rewrite）。
- 模型清单来源要稳定：本插件**不调**供应商 `/v1/models`，一律以自维护注册表为准（参数全写全）；
  要"登记但不出现"就用 `disabled`，`enabled` 字段由此映射（`registry/models.ts:77`）。
- server 插件在**后台服务进程**里跑；改完插件**通常会被文件监视热重载**（实测：覆盖 `index.ts` 后 `/api/plugin` 立即可见 `status=active`，无需重启），必要时才 `opencode service restart`。
- 若供应商在 models.dev 目录里，其实连 provider/models 都不用注册，只需注册一个带 key 的 integration。

## 实测踩坑：本地 server 插件**不能** import `@opencode/plugin`

opencode **2.0.24** 实测：脚本安装到 `~/.config/opencode/plugins/<name>/` 的插件，若 `index.ts` 里写
`import { Plugin, Provider, Integration } from "@opencode/plugin"`，加载直接失败：

```
/api/plugin → { state: { status: "failed", error: "Plugin failed to load", ref: "err_xxxx" } }
日志 → failed to load plugin cause="ResolveMessage: Cannot find package '@opencode/plugin' imported from .../index.ts"
```

- `@opencode/plugin/tui` **是**注入的（TUI 入口照常写 `import { Plugin } from "@opencode/plugin/tui"`）；
  服务端入口的 `@opencode/plugin` **不是**（历史上要落盘 `~/.config/opencode/node_modules/`）。
- **解法：server 入口不 import 任何 `@opencode/*`。** 运行时需要的全是普通值：
  - `Plugin.define` 就是恒等函数 → `export default { id, setup }` 即可
  - `Provider.ID.make` / `Integration.ID.make` 运行时就是字符串
  - `Provider.Info.empty(id)` = `{ id, name: id, activation: "auto", package: "" }`，反正每个字段都会被覆盖
  - `import type` 会被擦除，所以类型可以照常写（或像本项目一样用结构化本地接口）
- 同一目录双入口的实测结果：`/api/plugin` 里该条目 `features: { server: true, tui: true }`，一个目录同时被两个运行时接受。

### 验证注册是否真的生效（可复用的证据链）

```bash
opencode api get /api/plugin      # 找自己那条：state.status 必须是 active（features.server=true）
opencode api get /api/integration # 注册的 integration：methods 有 key、metadata.source 是标记
opencode api get /api/model       # 只列**可用** provider 的模型；credential 前为空，连接后出现
opencode api get /api/provider    # activation/package/integrationID/settings.baseURL
opencode api post /api/integration/<id>/connect/key --data '{"key":"sk-test"}'
opencode api delete /api/credential/<cred_id>   # 用完清理
```

实测 `activation: "auto"` + 无凭据 ⇒ `/api/model` 里 0 条；`POST .../connect/key` 后立刻出现该 provider 的模型
（共享 `models` 表 + provider 覆盖都正确生效）；`DELETE` 凭据后又回到 0 条。

### 坑：注册表里的 id 和 `opencode.json` 里已声明的 provider 撞名（实测，结论分两层）

**实测现场**：注册表写了 `command-code` / `r4-coder`，`opencode.json` 里也声明了同名 `providers.<id>`（带 `settings.apiKey: "{env:…}"`）。
插件重载后两边**同时生效且各管一半**：

| 维度 | 谁生效 | 证据 |
|---|---|---|
| integration 的 `metadata.source` / `keyLabel`、`methods` 的 key 标签 | **注册表（插件）** | `/api/integration` 里 `metadata:{source:"opencode-providers",keyLabel:"Paste Command Code API key"}`、`methods[0].label` = 我们的 |
| provider 的 `activation` | **配置**（`enabled`，而不是我们的 `auto`） | `/api/provider` 显示 `activation:"enabled"` |
| provider 的 `settings.apiKey` | **配置**（`{env:…}` 被解析成真实值 / 未设则为空串） | `/api/provider` 里能看到解析后的 key；`COMMAND_CODE_API_KEY` 未设时是空串 ⇒ 该 provider 现在其实是**发不出去请求**的 |

后果：**模型会因为配置的 `activation: enabled` 而无凭据也可见**（`/api/model` 里就有），本插件 `auto` 语义（配了 key 才出现）对这两个 id 失效。

**处理**：要完全走「注册表 + `/connect`」，就把 `opencode.json` 里那些 `providers.<id>` 整块删掉再重启/重载；
此后 `activation` 才会是 `auto`、`apiKey` 才不会被配置层注入，key 改为在 `/connect-providers` 里粘一次。
反过来，某家若想继续用 `{env:…}`，就别写进注册表 —— **同 id 两边只留一边**。

> 迁移注意：配置里的 `{env:…}` key **不会**自动搬进 opencode 的凭据表，删掉配置块后要重新粘一次
> （TUI：`/` → 选中 `Connect providers`；等价命令：`opencode api post /api/integration/<id>/connect/key --data '{"key":"…","label":"<名字>"}'`）。
> 实测（本机 2026-10-07）：删掉配置块 + 重载后 —— integration 两条都带我们的 `metadata.source`/`keyLabel`、
> 无凭据时 `/api/model` 里两家各 0 条、都不进 `/api/provider` 的 available 列表；
> 给 `r4-coder` 粘上 key 后它立刻出现在 `/api/model`（1 条），`command-code` 没 key 就仍是 0 条。

> 安全提醒：把 `settings.apiKey` 写成 `{env:VAR}` 时，opencode 会把它**解析成明文**放进 provider settings
> （`/api/provider` 里肉眼可见）。所以带 key 的 provider 不要留在 `opencode.json` 里给工具去读。

**顺带两条实测**：
- 注册表里**删掉**某个 provider 后，它的 integration 会在下一次插件激活时消失（不是残留）；同理**换注册表 URL**后
  必须触发一次重载（改文件/重装/重启）才会用新地址。旧 URL 404 时插件沿用旧缓存，不会清空列表。
- 插件**装载时**若注册表不可用（换 URL 后旧路径 404、且新 key 无缓存），setup 会 `console.error` 后**直接 return**：
  插件仍显示 `active`，但**一条 integration 都不注册**（`/api/integration` 里自己的 0 条就是这个状态）。
- 插件里的 `console.*` **不会**进 `~/.local/share/opencode/log/opencode.log`（实测），所以别靠日志看插件内部报错；
  要复现「拉取+解析」是否正常，直接 `node -e` 调 `loadRegistry`（见 `registry/source.ts` 的注入式设计）。

### 真机验证「注册表 → 注册」链路：探针注册表法（实测有效）

当真实注册表的 id 与配置撞名、不好判定时，用**临时探针注册表**把链路钉一遍（不动用户配置、不动数据库）：

1. 本地起一个只回一份 JSON 的 HTTP 服务（`registry.json` 里放一个不会撞名的 `probe-check` provider）；
2. 只改**已安装副本**的 `registry/source.ts` 里的 `DEFAULT_REGISTRY_URL` → `http://127.0.0.1:<port>/registry.json`
   （缓存键含 URL，所以等价于强制重新拉取，不必等 6h TTL）；
3. 等文件监视热重载，然后断言：
   - `/api/integration` 里出现 `probe-check`，且 `metadata.source`、`keyLabel`、`methods` 的 key 标签**都是注册表里的值**；
   - 无凭据时该 provider 在 `/api/model` 里 **0 条**（`activation: auto` 生效）；
   - `POST /api/integration/probe-check/connect/key` 后出现模型，且 `modelID` 覆盖 / `limit` / `variants` 与注册表一致；
     同时 `/api/provider` 显示 `activation:"auto"`、`integrationID:"probe-check"`、`package`、`settings.baseURL`；
   - `DELETE /api/credential/<id>` 后回到 0 条；
4. 用 `install.sh --local` / `install.ps1 -Local` 覆盖回真实源码，再确认 `probe-check` 已消失。
5. **删掉探针留下的缓存行**（否则 `kv` 里永久多一条死行，见上一节的教训）：

   ```bash
   node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.USERPROFILE+'\\.local\\share\\opencode\\opencode.db');const ns='plugin:'+[...'opencode-providers'].map(c=>c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+':';console.log(db.prepare('DELETE FROM kv WHERE key = ?').run(ns+'registry-cache:http://127.0.0.1:45999/registry.json'))"
   ```

实测输出（2026-10-07）：

```
probe-check 已注册: {"name":"Probe Check","metadata":{"source":"opencode-providers","keyLabel":"Paste probe key"},
                    "methods":[{"type":"key","label":"Paste probe key"}]}
凭据前: probe-check 模型数 = 0
凭据后: probe-check/probe-model modelID=probe/routed-model limit={"context":200000,"output":20000} variants=low,high
provider: {"activation":"auto","integrationID":"probe-check","package":"@opencode/ai/providers/openai-compatible",
           "baseURL":"http://127.0.0.1:45999/v1"}
清理后: probe-check 模型数 = 0
```
