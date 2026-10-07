# registry 拆分：按供应商分文件 + 运行期聚合 + 强制刷新

- 日期：2026-10-07
- 状态：**设计已批准**（`docs/plans/2026-10-07-registry-split.md` 为实现计划）
- 相关：`docs/opencode-plugin-provider-no-config.md`、`docs/npm-distribution-and-testing.md`、`.opencode/skills/opencode-providers-registry/`

## 1. 背景与动机

现状：注册表是单文件 `registry/registry.json`（含顶层 `models` 共享表 + `providers`）。随供应商/模型增长会持续膨胀；agent/人读一次成本高（本仓技能已改为「不读整份、只走 CLI」，但文件本身仍会变大）。

目标：**源按供应商拆成小文件**，人/agent 只碰小文件；**插件在运行期把它们聚合成一份 Registry** 并持久化到 kv 缓存（保持 6h TTL）；TUI 提供**强制刷新**，上游更新后不必重启 + 等 6h。

参照与证据：

- models.dev 仓库（`github.com/anomalyco/models.dev`，默认分支 `dev`）就是「分文件源 + 生成聚合」：
  - 供应商参数 `providers/<id>/provider.toml`；该家模型 `providers/<id>/models/**/<id>.toml`；厂商无关的 lab 模型 `models/<lab>/<model>.toml`。
  - 生成器 `packages/core/src/generate.ts`：`generateModels()` 扫 `models/**/*.toml`（**model id = 相对路径去掉 `.toml`**，不写 `id` 字段）；`generateProviders()` 扫 `*/provider.toml`（**providerID = 目录名**），产出 `{ models, providers }` 单对象。
  - 中转模型用 `base_model = "<lab>/<model>"` + 只写覆盖项。
- opencode 内核只抓**单个聚合**：`packages/core/src/models-dev.ts:346` `fetch(`${source}/api.json`)`（source = `https://models.opencode.ai`），另有 `models-dev.ts:281` 一份 committed 快照。→ 因此「模仿 models.dev」= 源分文件、聚合消费。
- 但本需求要**运行期聚合**（用户明确），所以插件必须能「发现有哪些供应商文件夹」。GitHub raw **不能列目录** → 需要一个 manifest 入口。

## 2. 目标 / 非目标

目标：

1. `registry/` 按供应商拆分为小文件，`provider` 存供应商参数、`models` 存模型参数。
2. 插件运行期抓 manifest + 各分文件，聚合成与现有 `Registry` 完全同形的对象，写入 `ctx.storage`（kv），**6h TTL**，失败沿用 stale cache。
3. `/connect-providers` 弹窗加「强制刷新」动作（footer 动作 + 快捷键），绕过 TTL 重拉并重注册。
4. 技能 CLI 改写为操作分文件、自动维护 manifest；agent 仍不读整份。
5. CI 校验：分文件能聚合且过 `parseRegistry`；manifest 与实际文件一致。

非目标：

- **本次是破坏性结构变更**（改插件取数代码 + 默认地址 + 删旧文件），**需要发新插件版本**（发版走本仓既有手动流程；本 spec/计划只负责把变更记进 `CHANGELOG` 的 `[Unreleased]` 并说明影响）。
  - 「注册表**数据**改动不需要发版」这条仍成立（新增/修改供应商仍不用发版）。
  - 旧版本（≤0.1.0）仍拉旧地址 `registry/registry.json` → 迁移后该地址 404 → 沿用本地缓存、不再更新，需升级。
- 不引入 TOML / 新依赖；源文件用 **JSON**。
- 不做「加 `env` 认证 / 账号改名删除 / 覆盖已有条目」。
- 不保留已废弃的单文件 `registry/registry.json`（迁移时删除），旧 `registry/registry.schema.json` 一并删除（校验改以 `parseRegistry` / CLI `validate` 为准）。

## 3. 源结构

```
registry/
  index.json                       # manifest（脚本自动维护，人手不碰）
  providers/
    <id>/
      provider.json                # 供应商参数
      models.json                  # 该家模型
  models/                          # 顶层共享模型（厂商无关事实）
    <lab>/<model>.json
```

- **模型 key = `models.json` 里的对象键**，不写 `id` 字段（对齐 models.dev「filename 即 id」）。
- 路径段规则（**Windows 可 checkout**，吸取 models.dev 在 Windows 上 checkout 失败的教训）：
  `<id>` / `<lab>` / `<model>` 均须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$`（禁 `/ \ : * ? " < > |` 及空白）。
  → 因此模型参数全部收在**单个 `models.json`** 里（不再为每个模型建目录），从根上避免文件名问题。

`providers/<id>/provider.json`（最小字段）：

```jsonc
{ "name": "Open Design", "package": "@opencode/ai/providers/openai-compatible", "baseURL": "https://api.open-design.ai/v1" }
```

`providers/<id>/models.json`（键 = 模型 key；`ModelSpec` 同现有 schema，最小字段为 name/modelID/limit/variants/base）：

```jsonc
{
  "open-design-chat": {
    "name": "Open Design Chat",
    "modelID": "open-design-chat-v1",
    "limit": { "context": 131072, "output": 32768 },
    "variants": [{ "id": "low", "settings": { "reasoningEffort": "low" } }]
  }
}
```

`models/<lab>/<model>.json`（`RegistryModel`：name/family/limit/cost/tools/input/output/variants/…；注意 `family` 是**文件内字段**，与路径段 `<lab>` 不是一回事）：

```jsonc
{ "name": "Deepseek V4.1 Flash", "family": "deepseek", "limit": { "context": 1048576, "output": 393216 },
  "variants": [{ "id": "low", "settings": { "reasoningEffort": "low" } }, { "id": "high", "settings": { "reasoningEffort": "high" } }] }
```

## 4. Manifest（`registry/index.json`）

```jsonc
{
  "schemaVersion": 1,
  "revision": "sha256:…",           // 所有源文件内容的确定性哈希
  "providers": ["command-code", "r4-coder"]
}
```

- `providers` = 供应商 id 列表 → 插件据此拼出 `providers/<id>/provider.json` 与 `models.json` 的 URL（相对 manifest URL 解析）。
- `revision` = 对 `providers/**` 与 `models/**` 全部文件（不含 `index.json`）按 posix 相对路径排序后做内容哈希。**任何文件改动都会改 `revision` → 改 manifest 文本**。
  - 这是为堵住正确性缺口：若 manifest 只列 id，只改某个 `models.json` 时 manifest 文本不变，客户端 304 短路会漏更新。
- 由 CLI 在**每次写文件后自动重算**（`sync`）；CI 校验（见 §10）。人/agent 不手改。

## 5. 共享模型与 `base` 引用

- 保留顶层共享表：`models/<lab>/<model>.json`。
- provider 模型用 `base: "<lab>/<model>"` 引用，指向 `models/<lab>/<model>.json`（对齐 models.dev 的 `base_model`；路径第一段是 **lab id**，`family` 只是 lab 模型内的字段，别混）。
- **只按需拉取**：聚合时收集 provider 模型里出现的唯一 `base`，逐个拉对应文件；不列全、不拉未被引用的。
- 单家独有模型一律**内联**在 `providers/<id>/models.json`，不硬抽到顶层。

## 6. 插件运行期聚合与缓存（`registry/source.ts` + 新 `registry/aggregate.ts`）

**缓存契约保持不变**：kv 里存**聚合后的 body**（`{schemaVersion, models, providers}` 的 JSON 字符串）+ `{ etag, revision, fetchedAt }`；`parseRegistry` 与 `models.ts` 下游零改动。缓存键仍为 `registry-cache:<manifest url>`，**TTL 6h**（`DEFAULT_TTL_MS` 不变）。

取数流程：

1. 读缓存；`now - fetchedAt < ttl` 且 body 可解析 → 直接用（`source: "cache"`）。
2. 抓 manifest（带 `If-None-Match`）：
   - 失败 / 非 2xx → stale fallback（有缓存则用旧聚合）。
   - **304**：缓存 body 可解析 → 只刷新 `fetchedAt`（`source:"cache"`）；缓存 body **损坏** → 发一次**无条件 GET** 取回 manifest body 再走重建（RF2）。
   - **revision 与缓存一致**且缓存 body 可解析 → 保留旧聚合，仅刷新 `fetchedAt`（`source: "cache"`）——**不重拉子文件**。
   - revision 不同 → 进入 3。
3. 并发拉 `providers/<id>/provider.json` + `models.json`；收集 `base` → 并发拉 `models/<base>.json`。
4. **逐家构造单家候选**并 `parseRegistry` 校验；通过才纳入（字段非法的家 warn 跳过，RF1/RF3）。
5. 组装聚合对象 → 再 `parseRegistry`；通过 → 写缓存（`source: "network"`）；不通过 → stale fallback。

失败语义：

- manifest 失败 → stale；无缓存则 `ok:false`。
- **单个 provider 拉取 / JSON / 字段非法 → 跳过该家并 warn**，其余照常。
- 某 provider 引用的 `base` 拉不到 → 跳过**该家**并 warn（`parseRegistry` 会因 unknown base 拒绝这家）。
- 成功供应商数 = 0 → 视为失败 → stale fallback。

新增模块 `registry/aggregate.ts`（纯逻辑、可注入读取器，便于 `node --test`）：

```ts
export interface Manifest { readonly schemaVersion: number; readonly revision: string; readonly providers: readonly string[] }
export function parseManifest(json: unknown): { ok: true; manifest: Manifest } | { ok: false; errors: readonly string[] }
export type BuildRegistryResult =
  | { ok: true; registry: { schemaVersion: number; models: Record<string, unknown>; providers: Record<string, Record<string, unknown>> }; warnings: readonly string[] }
  | { ok: false; errors: readonly string[]; warnings: readonly string[] }
export async function buildRegistry(manifest: Manifest, readJson: (relativePath: string) => Promise<unknown>): Promise<BuildRegistryResult>
```

（以 `docs/plans/2026-10-07-registry-split.md` Task 1 的签名为准。）

`source.ts` 负责：URL 派生（`new URL(rel, manifestUrl)`）、TTL/ETag/revision 短路、缓存读写、stale fallback；`force` 选项用于强制刷新。`LoadRegistryResult` 成功分支增加 `warnings: readonly string[]`。

## 7. 强制刷新（TUI + 服务端 RPC）

新增共享定义模块 `plugin/opencode-providers/rpc.ts`（**纯 JSON Schema，零依赖**，服务端入口可 import 而不违反「不 import `@opencode/*`」）：

```ts
export const registryRpc = {
  id: "opencode-providers",
  methods: {
    refresh: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          providers: { type: "number" },
          models: { type: "number" },
          source: { type: "string" },        // "network" | "cache" | "stale-cache"
          fetchedAt: { type: "number" },
          errors: { type: "array", items: { type: "string" } },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const
```

服务端（`index.ts`）：

- 把注册数据放进 **`setup` 内的可变 `state`**（闭包持有，**不用模块级**，避免多实例 / 多次 `setup` 互相污染）；`integration.transform` / `provider.transform` 的闭包从 `state` 读取。**始终**注册这两个 transform（`state` 为空则 no-op），使首次加载失败后仍能靠刷新恢复。
- `await ctx.rpc.register(registryRpc, { refresh: async () => { … } })`：
  1. `loadRegistry({ force: true })`（绕过 TTL）；
  2. **成功判据 = `result.ok && result.source !== "stale-cache"`**（`network` 拉新、`cache` 确认无变化都算成功）；
  3. 成功 → 更新 `state` 并 `await ctx.integration.reload()`、`await ctx.provider.reload()`；否则返回 `{ ok:false, errors }` 且**不动 state**（RF4）；
  4. 返回 `{ ok, providers, models, source, fetchedAt }`；`providers` = 供应商数，`models` = 各 provider 模型条目之和。
- 结构性类型 `SetupContextLike` 增补 `rpc.register`、`provider.reload`、`integration.reload`（仍不 import `@opencode/*`）。

TUI（`view/connect.ts`）：

- `/connect-providers` 首个选择弹窗加一个 footer 动作：
  `{ title: "Force refresh", bind: "mod+r", selection: "none", onTrigger: () => forceRefresh(ctx) }`。
  它被渲染成弹窗底部**一行可点击的「按钮」**，同时带快捷键——三种触发方式跑同一个 `onTrigger`：
  ① 鼠标点该行；② `Tab` 聚焦到该行后回车；③ 直接按 `mod+r`（`mod` = macOS 下 Cmd、Windows/Linux 下 Ctrl）。
  （证据：`packages/tui/src/ui/dialog-select.tsx` 的 `FooterAction` 渲染 `title`+键位并 `onMouseUp` 触发。）
- `forceRefresh(ctx)`：`ctx.client.rpc(registryRpc).refresh({})` → 成功 `toast` 并 `ctx.data.location.integration.invalidate(ctx.location)`（连带 provider/model）刷新列表；失败仅 error `toast`、不 invalidate。
- 空态（当前无本插件供应商）：`dialog.confirm({ title, message, label: { confirm: "Force refresh" } })` → 确认则 `forceRefresh(ctx)` 并提示「已刷新，重新运行 /connect-providers」（**不递归**，避免循环）。

## 8. 技能 CLI（`.opencode/skills/opencode-providers-registry/scripts/registry.mjs`）

保持命令语义，改写为操作分文件：

| 命令 | 行为 |
|---|---|
| `list` / `search` / `show` | 遍历 `providers/*/`（读 `provider.json` + `models.json`）与 `models/**`；agent 不读整份 |
| `add-provider …` | 建 `providers/<id>/provider.json` + `models.json`，并把 `<id>` 写入 `index.json` |
| `add-model …` | 写入 `providers/<id>/models.json`（同 key 冲突报错） |
| `add-shared-model …` | 写入 `models/<lab>/<model>.json` |
| `sync` | 重算 `revision` 并重写 `index.json`（`providers` 排序） |
| `validate` | 聚合后过 `parseRegistry`；并校验「`index.json` 的 id 集合 == `providers/*/` 实际目录集合」与 `revision` 一致 |

- 所有写命令仍在落盘前校验；写完**重算 `revision`** 并重写 `index.json`。
- 源文件为机器生成，采用固定 `JSON.stringify(value, null, 2) + "\n"`（不再需要旧的「复刻手写单文件排版」的宽高启发式）。
- 路径段校验：`base` / `--lab` / `--key` / `--id` 一律按 `/` **拆段、逐段**套 §3 的安全正则（整串套会对含 `/` 的 `base` 误拒）。

## 9. 迁移

1. 新建 `registry/index.json`（`revision` 由 CLI `sync` 生成）。
2. `providers/command-code/provider.json` + `models.json`（含 `base: "deepseek/deepseek-v4.1-flash"`、`modelID: "deepseek/deepseek-v4.1-flash"`）。
3. `providers/r4-coder/provider.json` + `models.json`（`base: "deepseek/deepseek-v4.1-flash"`）。
4. `models/deepseek/deepseek-v4.1-flash.json`（现顶层共享模型）。
5. 删除 `registry/registry.json` 与孤儿 `registry/registry.schema.json`（旧单文件形状 schema；校验改以 `parseRegistry` / CLI `validate` 为准）。
6. `DEFAULT_REGISTRY_URL` → `.../registry/index.json`。
7. 更新 `AGENTS.md`、`README.md`、`docs/opencode-plugin-provider-no-config.md`、`.opencode/skills/opencode-providers-registry/SKILL.md`、`CHANGELOG.md`（`[Unreleased]` 记破坏性变更）。

## 10. 测试与 CI

- `tests/models.test.ts`：不变（`resolveModelSpec` 语义未动）。
- `tests/schema.test.ts`：**改**——删掉读 `registry/registry.json` 的 `"shipped registry.json parses"`（原 118-123 行），换成分文件版（`index.json` → `buildRegistry` → `parseRegistry`）。
- `tests/registry.test.ts`：**改**——同上（读分文件 → 聚合 → 断言两家原参数）。
- 新增 `tests/aggregate.test.ts`：`parseManifest` 正误、`buildRegistry` 正常 / 单家失败跳过 / **字段非法跳过** / base 缺失跳过 / 全失败报错。
- 改 `tests/source.test.ts`：新鲜缓存、`force`、304（含**缓存损坏 → 无条件 GET 重建**）、revision 一致不重拉、revision 变化重拉、stale fallback、子文件 404 跳过。
- 改 `tests/setup.test.ts`：假 fetch 改「manifest + 分文件」；断言注册结果不变；新增 refresh 用例（成功 `reload`；**RF4：失败不动 state**）；用 `setup` 内 state 保证多次 setup 不互相污染。
- 新增 `tests/connect.test.ts`：`forceRefresh` 成功/失败；非空态 `dialog.select` 的 `actions` 含 `Force refresh` + `mod+r`。
- 重写 `tests/registry-cli.test.ts`：分文件读写、冲突、`index.json`/`revision`、`sync`、格式化幂等、非法路径段（RF5）。
- CI（`.github/workflows/ci.yml`）：保留 `node --test`；新增一步 `registry.mjs validate`。

## 11. 风险与未决

- **HTTP 次数**：每次刷新 = 1 manifest + N 家 ×2 + 引用共享模型数。用 `revision`/ETag 短路把稳态刷新压到 1 次请求。
- **`client.rpc(plainDefinition)` / `ctx.rpc.register` 接受纯对象**：已核实——`Rpc.define` 是恒等函数（`packages/schema/src/rpc.ts:54`），核心 `parse()` 接受纯 JSON Schema（`packages/core/src/rpc.ts`），`client.rpc(def)` 与 `ctx.rpc.register` 均可直接传纯对象定义。
- **`ctx.rpc` / `provider.reload` 在本地 server 插件可用**：文档 `services/www/src/docs/content/build/plugins/rpc.mdx` 与 `packages/core/test/plugin/supervisor-reload.test.ts:132` 佐证；仍以真机冒烟为准。
- **GitHub raw 相对 URL 解析**：`new URL("providers/x/provider.json", ".../registry/index.json")` → `.../registry/providers/x/provider.json`；单测覆盖。
- **共享模型哈希纳入 revision**：`models/**` 改动也必须改 `revision`（否则漏更新），CI 与 CLI 都要覆盖。
- **未决**：manifest 是否也列 `models` 列表（当前**不列**，按需拉取）；`bind` 键位最终值（暂定 `mod+r`）。

## 12. 影响文件清单

- 源：`registry/**`（新增分文件 + `index.json`；删 `registry/registry.json`、`registry/registry.schema.json`）。
- 插件：`plugin/opencode-providers/registry/aggregate.ts`（新）、`registry/source.ts`（改）、`index.ts`（改：setup 内 state + rpc）、`rpc.ts`（新）、`view/connect.ts`（改：动作 + 空态）、`tui.ts`（不变）。
- 技能：`.opencode/skills/opencode-providers-registry/SKILL.md`、`scripts/registry.mjs`。
- 测试：`tests/aggregate.test.ts`（新）、`tests/connect.test.ts`（新）、`tests/source.test.ts`（改）、`tests/setup.test.ts`（改）、`tests/registry.test.ts`（改）、`tests/schema.test.ts`（改）、`tests/registry-cli.test.ts`（改）。
- CI/文档：`.github/workflows/ci.yml`、`AGENTS.md`、`README.md`、`docs/opencode-plugin-provider-no-config.md`、`CHANGELOG.md`、本 spec 与计划。
