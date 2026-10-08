# registry 拆分（分供应商文件 + 运行期聚合 + 强制刷新）Implementation Plan

> **历史冻结**：本次改动的实现计划，已执行完毕，只读、不回填、不当现状。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把注册表从单文件改成「按供应商分目录的 JSON 源」，插件运行期聚合 + kv 缓存（6h TTL），并在 `/connect-providers` 弹窗加「强制刷新」。

**Architecture:** 源 = `registry/index.json`（manifest）+ `registry/providers/<id>/{provider,models}.json` + `registry/models/<lab>/<model>.json`。插件 `source.ts` 拉 manifest，用其 `revision` 做「无变化短路」，变了就并发拉各子文件、**逐家校验**后聚合成与现有 `Registry` 同形的对象，过 `parseRegistry` 后写 kv。强制刷新经服务端 RPC（纯 JSON Schema，零 `@opencode/*` 依赖）绕过 TTL 重拉 + `provider/integration.reload()`。

**Tech Stack:** TypeScript（Node ≥24 原生类型擦除）、`node --test`、`node:crypto`（仅 CLI）、零新依赖、JSON；opencode 2.0.x 插件 API（transform/reload/rpc）。

**Spec:** `docs/specs/2026-10-07-registry-split-design.md`

## Global Constraints

- Node ≥ 24（`node --test` 直接跑 `.ts`）；**零新依赖**（不引 TOML/解析库）。
- 源文件只用 **JSON**；聚合 body 必须是 `{ schemaVersion, models, providers }`。
- **server 入口及其 import 的模块不得 import 任何 `@opencode/*`**（`index.ts` / `rpc.ts` / `registry/*`）；TUI 入口可。
- 相对导入必须带显式扩展名（`./rpc.ts`）。
- TUI 入口**不写 JSX**（`tui.ts` 保持 `.ts`）。
- 路径段（供应商 id / lab / model）必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$`（禁 `/ \ : * ? " < > |` 与空白）。
- 缓存键 `registry-cache:<index.json url>`；TTL = `DEFAULT_TTL_MS`（6h）。
- **单家校验后**才入聚合；聚合必须过 `parseRegistry` 才写缓存。
- 提交信息用**中文**；每个 commit 前 `node --test` 全绿。
- 迁移不得改变已注册结果：`command-code`/`r4-coder` 的 `keyLabel`、模型 `modelID`/`limit`/`variants` 原样保留。

## Review Focus

1. manifest 改了、但某家子文件拉取/JSON/字段非法 → **跳过该家**、其余照常（不是整份失败）。
2. `revision` 未变、但缓存 body 已损坏 → **回退重建**，不得把坏 body 当缓存返回。
3. 某家 `base` 指向不存在的 `models/<lab>/<model>.json` → **跳过该家**并 warn。
4. 强制刷新时上游不可达（有缓存 → stale-cache）→ 返回 `{ ok:false, errors }`，**不清空**已注册 provider（旧 state 保留）。
5. 路径段含 Windows 非法字符（如 `:`）→ CLI **报错拒绝**。

---

### Task 1: `registry/aggregate.ts`（manifest 解析 + **逐家校验**的聚合，纯逻辑）

**Files:**
- Create: `plugin/opencode-providers/registry/aggregate.ts`
- Test: `tests/aggregate.test.ts`

**Interfaces:**
- Consumes: `SUPPORTED_SCHEMA_VERSION`、`parseRegistry` from `./schema.ts`。
- Produces:
  ```ts
  export interface Manifest { readonly schemaVersion: number; readonly revision: string; readonly providers: readonly string[] }
  export type ParseManifestResult = { ok: true; manifest: Manifest } | { ok: false; errors: readonly string[] }
  export function parseManifest(input: unknown): ParseManifestResult

  export type BuildRegistryResult =
    | { ok: true; registry: { schemaVersion: number; models: Record<string, unknown>; providers: Record<string, Record<string, unknown>> }; warnings: readonly string[] }
    | { ok: false; errors: readonly string[]; warnings: readonly string[] }
  export async function buildRegistry(manifest: Manifest, readJson: (relativePath: string) => Promise<unknown>): Promise<BuildRegistryResult>
  ```
- 算法：① 读全部 `providers/<id>/provider.json`+`models.json`（非普通对象 → warn 跳过）；② 收集所有 `spec.base`，逐个 `readJson("models/"+base+".json")`（失败记录）；③ 对**每一家**构造单家候选 `{ schemaVersion, models: 其引用的共享子集, providers: { [id]: entry } }`，`parseRegistry` 通过才纳入（否则 warn 跳过，覆盖 RF1/RF3/RF6）；④ 无任何一家通过 → `{ ok:false, errors:["no providers could be loaded"], warnings }`。

- [ ] **Step 1: 写失败测试** `tests/aggregate.test.ts`

```ts
import assert from "node:assert/strict"
import test from "node:test"
import { buildRegistry, parseManifest } from "../plugin/opencode-providers/registry/aggregate.ts"

const manifest = { schemaVersion: 1, revision: "sha256:r1", providers: ["acme", "broken"] }
const reader = (files: Record<string, unknown>) => async (path: string) => {
  if (!(path in files)) throw new Error(`404 ${path}`)
  return files[path]
}

test("parseManifest 接受合法、拒绝非法", () => {
  assert.equal(parseManifest(manifest).ok, true)
  assert.equal(parseManifest({ schemaVersion: 2, revision: "x", providers: [] }).ok, false)
  assert.equal(parseManifest({ schemaVersion: 1, revision: "", providers: [] }).ok, false)
  assert.equal(parseManifest({ schemaVersion: 1, revision: "x", providers: [1] }).ok, false)
})

test("buildRegistry 组装 + 按需拉 base，坏家跳过", async () => {
  const files = {
    "providers/acme/provider.json": { name: "Acme", package: "pkg", baseURL: "https://acme.example/v1" },
    "providers/acme/models.json": { m: { base: "deepseek/deepseek-v4.1-flash" } },
    "models/deepseek/deepseek-v4.1-flash.json": { limit: { context: 10, output: 2 } },
    "providers/broken/provider.json": { name: "Broken", package: "pkg" },
    "providers/broken/models.json": { m: { base: "missing/model" } },
  }
  const result = await buildRegistry(manifest, reader(files))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(Object.keys(result.registry.providers), ["acme"])
  assert.ok(result.warnings.some((w) => w.includes("broken")))
  assert.deepEqual(Object.keys(result.registry.models), ["deepseek/deepseek-v4.1-flash"])
})

test("字段非法的一家（内联模型缺 limit）被跳过，其余照常（RF1）", async () => {
  const files = {
    "providers/acme/provider.json": { name: "Acme", package: "pkg" },
    "providers/acme/models.json": { m: { limit: { context: 10, output: 2 } } },
    "providers/bad/provider.json": { name: "Bad", package: "pkg" },
    "providers/bad/models.json": { m: { name: "no-limit-no-base" } },
  }
  const result = await buildRegistry(manifest, reader(files))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(Object.keys(result.registry.providers), ["acme"])
})

test("全坏 → ok:false", async () => {
  const result = await buildRegistry({ ...manifest, providers: ["broken"] }, reader({}))
  assert.equal(result.ok, false)
})
```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test tests/aggregate.test.ts` — Expected: FAIL（模块不存在）。
- [ ] **Step 3: 实现 `aggregate.ts`**（算法见上）。
- [ ] **Step 4: 跑测试确认通过** — Run: `node --test tests/aggregate.test.ts` — Expected: PASS。
- [ ] **Step 5: 提交**
```bash
git add plugin/opencode-providers/registry/aggregate.ts tests/aggregate.test.ts
git commit -m "feat(registry): 新增分文件聚合器 aggregate.ts（逐家校验）"
```

---

### Task 2: 迁移 registry 源为分文件；改写/删除所有读旧文件的测试与 schema

**Files:**
- Create: `registry/index.json`、`registry/providers/command-code/{provider,models}.json`、`registry/providers/r4-coder/{provider,models}.json`、`registry/models/deepseek/deepseek-v4.1-flash.json`
- Delete: `registry/registry.json`、`registry/registry.schema.json`
- Modify: `tests/registry.test.ts`、`tests/schema.test.ts`
- Modify（仅删旧用例/改引用，完整更新留 Task 7）: 无

**Interfaces:**
- Consumes: `buildRegistry`（Task 1）、`parseRegistry`（现有）。
- Produces: 分文件数据树；`index.json` = `{ schemaVersion: 1, revision: <非空串>, providers: ["command-code","r4-coder"] }`（revision 由 Task 6 的 `sync` 重算）。

- [ ] **Step 1: 写数据文件**（内容照搬旧单文件，字段不改）
  - `providers/command-code/provider.json` = `{ "name": "Command Code", "package": "@opencode/ai/providers/openai-compatible", "baseURL": "https://api.commandcode.ai/provider/v1", "keyLabel": "Paste Command Code API key" }`
  - `providers/command-code/models.json` = `{ "deepseek-v4.1-flash": { "base": "deepseek/deepseek-v4.1-flash", "modelID": "deepseek/deepseek-v4.1-flash" } }`
  - `providers/r4-coder/provider.json` = `{ "name": "R4 Coder", "package": "@opencode/ai/providers/openai-compatible", "baseURL": "https://api.r4.codes/v1", "keyLabel": "Paste R4 Coder API key" }`
  - `providers/r4-coder/models.json` = `{ "deepseek-v4.1-flash": { "base": "deepseek/deepseek-v4.1-flash" } }`
  - `models/deepseek/deepseek-v4.1-flash.json` = 旧顶层 `deepseek-v4.1-flash` 对象原样（name/family/limit/tools/input/output/variants）。
  - `index.json` revision 先写 `"sha256:placeholder"`（Task 6 `sync` 重算）。
  - 删除 `registry/registry.json` 与孤儿 `registry/registry.schema.json`（旧 schema 描述已删除的单文件形状；校验以 `parseRegistry`/CLI 为准）。

- [ ] **Step 2: 改写 `tests/registry.test.ts`**（读分文件 → buildRegistry → parseRegistry）
```ts
const root = new URL("../registry/", import.meta.url)
const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, root), "utf8"))
const m = parseManifest(read("index.json")); if (!m.ok) throw new Error(m.errors.join("\n"))
test("随仓分文件聚合后过 schema，两家参数原样", async () => {
  const built = await buildRegistry(m.manifest, async (rel) => read(rel))
  assert.equal(built.ok, true); if (!built.ok) return
  const parsed = parseRegistry(built.registry); assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("\n"))
  assert.equal((built.registry.providers["command-code"] as any).models["deepseek-v4.1-flash"].modelID, "deepseek/deepseek-v4.1-flash")
  assert.equal((built.registry.providers["r4-coder"] as any).models["deepseek-v4.1-flash"].modelID, undefined)
})
```

> **约束（评审 B）**：新版必须**逐条保留**旧 `tests/registry.test.ts` 的三条用例——① `parseRegistry.ok`；② `command-code`/`r4-coder` 的 `baseURL` 与 `keyLabel` 断言；③ `buildProviderModels` 的 `id`/`name`/`limit`/`variants=["low","high","max"]`/`reasoningEffort="max"`/`capabilities.tools` 与两家 `modelID` 断言。只把「读单文件」换成「读 `index.json` → `buildRegistry` → `parseRegistry`」，断言值一字不改。

- [ ] **Step 3: 改 `tests/schema.test.ts`** —— 删除末条 `"shipped registry.json parses"`（`schema.test.ts:118-123`），把它换成分文件版（读 `index.json` → `buildRegistry` → `parseRegistry.ok`）。`parseRegistry` 的其它单测保持不变。
- [ ] **Step 4: 跑测试** — Run: `node --test tests/registry.test.ts tests/schema.test.ts tests/aggregate.test.ts` — Expected: PASS。
- [ ] **Step 5: 提交**
```bash
git add registry tests/registry.test.ts tests/schema.test.ts
git rm registry/registry.json registry/registry.schema.json
git commit -m "refactor(registry): 迁移为按供应商分文件 + manifest，替换旧单文件"
```

---

### Task 3: 重写 `registry/source.ts`（manifest 取数 + revision 短路 + force + 坏缓存重建）

**Files:**
- Modify: `plugin/opencode-providers/registry/source.ts`
- Test: `tests/source.test.ts`（整体重写）

**Interfaces:**
- Consumes: `parseManifest`/`buildRegistry`、`parseRegistry`。
- Produces:
  ```ts
  export const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/Just-Silver/opencode-providers/main/registry/index.json"
  export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000
  export interface RegistryCacheEntry { readonly etag?: string; readonly revision?: string; readonly fetchedAt: number; readonly body: string }
  export interface LoadRegistryOptions { store; fetch; url?; now?; ttlMs?; timeoutMs?; force?: boolean }
  export type LoadRegistryResult =
    | { ok: true; registry: Registry; source: "cache" | "network" | "stale-cache"; fetchedAt: number; warnings: readonly string[] }
    | { ok: false; errors: readonly string[] }
  export async function loadRegistry(options: LoadRegistryOptions): Promise<LoadRegistryResult>
  ```
- 规则：304 → 若 `parseBody(cached.body).ok` 则只刷 `fetchedAt`；否则**发一次无条件 GET** 取回 manifest body 再走重建（RF2）。`revision` 短路：`cached.revision === manifest.revision && parseBody(cached.body).ok` → 只刷 `fetchedAt`（`source:"cache"`）。写缓存带 `revision`。

- [ ] **Step 1: 写失败测试** `tests/source.test.ts`（假 fetch 按 URL 返回 manifest/子文件；`filesFetch(map)` 记录 `calls`）
  - ① 新鲜缓存不打网络；② `force` 绕过 TTL；③ manifest 带 `If-None-Match`，304 + 合法缓存 → 保留旧 body、只刷 `fetchedAt`、`calls.length===1`；④ revision 未变 → 不重拉子文件（`calls.length===1`）；⑤ revision 变化 → 重拉并写缓存（body 含新家）；⑥ 网络失败回退 stale；⑦ **304 且缓存 body 损坏 → 无条件 GET 后重建**（RF2，断言第二次 GET 无 `if-none-match`）；⑧ 某家子文件 404 → 跳过该家、其余注册成功且 `warnings` 非空（RF3）；⑨ **200 且 revision 未变、但缓存 body 损坏 → 重建**（RF2 另一路，断言重拉子文件并写回合法 body）；⑩ 写缓存后读回的 `revision` == manifest.revision（评审 14，`asCacheEntry` 整对象透传须保留该字段）。
- [ ] **Step 2: 跑测试确认失败** — Run: `node --test tests/source.test.ts` — Expected: FAIL。
- [ ] **Step 3: 实现 `source.ts`**（读流见 spec §6；`readJson` 用 `new URL(rel, url)` + `AbortSignal.timeout`）。
- [ ] **Step 4: 跑测试确认通过** — Run: `node --test tests/source.test.ts` — Expected: PASS。
- [ ] **Step 5: 提交**
```bash
git add plugin/opencode-providers/registry/source.ts tests/source.test.ts
git commit -m "feat(registry): source 改 manifest 取数 + revision 短路 + force + 坏缓存重建"
```

---

### Task 4: 服务端接线（setup 内 state + RPC refresh + reload）

**Files:**
- Create: `plugin/opencode-providers/rpc.ts`
- Modify: `plugin/opencode-providers/index.ts`
- Test: `tests/setup.test.ts`

**Interfaces:**
- Consumes: `loadRegistry`（Task 3）。
- Produces: `registryRpc`（纯 JSON Schema）：
  ```ts
  export const registryRpc = {
    id: "opencode-providers",
    methods: { refresh: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object", properties: {
        ok: { type: "boolean" }, providers: { type: "number" }, models: { type: "number" },
        source: { type: "string" }, fetchedAt: { type: "number" },
        errors: { type: "array", items: { type: "string" } },
      }, required: ["ok"], additionalProperties: false },
    } },
    events: {},
  } as const
  ```
  `SetupContextLike` 增补 `rpc.register`、`provider.reload()`、`integration.reload()`。
  **refresh 成功判据**：`result.ok && result.source !== "stale-cache"`（`network`=拉新，`cache`=确认无变化，都算成功）；否则返回 `{ ok:false, errors }` 且**不动 state**（RF4）。`providers` = `Object.keys(registry.providers).length`；`models` = 所有 provider 模型条目之和。

- [ ] **Step 1: 改/写测试** `tests/setup.test.ts`
  - `withFetch` 改为「按树返回」（manifest + 分文件）；原有两条注册断言（keyLabel/activation/baseURL/modelID/limit/variants）保持不变。
  - 用**闭包内 state**：连续两次 `setup`（现有「缓存按 URL 隔离」用例）不得互相污染。
  - **改 fetch 计数断言（评审 A）**：分文件取数下首次 `setup` = 1 manifest + 2×(`provider.json`+`models.json`) + 1 共享子文件 = **6 次**（原 `assert.equal(calls, 1)` 必改）；第二次 `setup`（有新鲜缓存）= **+0**。
  - 新增：假 `rpc.register` 捕获 handlers，调用 `refresh()`（manifest revision 未变）→ 返回 `{ ok:true, providers:2 }` 且 `integration.reload`/`provider.reload` 各被调 1 次。
  - 新增（RF4）：refresh 时 fetch 全 404（有缓存）→ 返回 `{ ok:false, errors:[…] }`，`state.providers` 仍为旧的 2 条、**未**调用 reload。
- [ ] **Step 2: 跑测试确认失败** — Run: `node --test tests/setup.test.ts` — Expected: FAIL。
- [ ] **Step 3: 实现 `rpc.ts` 与改 `index.ts`**：`setup` 内 `const state = { registry: undefined }`；`loadRegistry` → 成功则 `state.registry = …`（失败只 log）；**始终**注册两个 transform（回调读 `state.registry`，空则 no-op）；`ctx.rpc.register(registryRpc, { refresh })`。
- [ ] **Step 4: 跑测试确认通过** — Run: `node --test tests/setup.test.ts` — Expected: PASS。
- [ ] **Step 5: 提交**
```bash
git add plugin/opencode-providers/rpc.ts plugin/opencode-providers/index.ts tests/setup.test.ts
git commit -m "feat(plugin): RPC 强制刷新 + setup 内 state/reload"
```

---

### Task 5: TUI `/connect-providers` 加强制刷新（按钮 + `mod+r`，含空态）

**Files:**
- Modify: `plugin/opencode-providers/view/connect.ts`
- Test: `tests/connect.test.ts`

**Interfaces:**
- Consumes: `registryRpc`（Task 4）、`ctx.client.rpc`、`ctx.ui.toast`、`ctx.ui.dialog`、`ctx.data.location.integration.invalidate`。
- Produces:
  ```ts
  export async function forceRefresh(ctx: Plugin.Context): Promise<void>   // ok=false → error toast，不 invalidate
  ```
  - 非空态：首个 `dialog.select` 加 `actions: [{ title: "Force refresh", bind: "mod+r", selection: "none", onTrigger: () => forceRefresh(ctx) }]`。
  - 空态（`integrations.length === 0`）：`dialog.confirm({ title:"Connect providers", message:"No providers…", label:{ confirm:"Force refresh" } })` → true 则 `forceRefresh(ctx)` 并提示「已刷新，重新运行 /connect-providers」；**不递归**（避免循环）。

- [ ] **Step 1: 写失败测试** `tests/connect.test.ts`
```ts
import assert from "node:assert/strict"
import test from "node:test"
import { connectProviders, forceRefresh } from "../plugin/opencode-providers/view/connect.ts"

test("forceRefresh 成功：调 rpc.refresh、invalidate、success toast", async () => {
  const seen: any = { refresh: 0, toasts: [], invalidated: 0 }
  const ctx = { location: {},
    client: { rpc: () => ({ refresh: async () => { seen.refresh++; return { ok: true, providers: 2, models: 2, source: "network", fetchedAt: 1 } } }) },
    ui: { toast: { show: (o: any) => seen.toasts.push(o) } },
    data: { location: { integration: { invalidate: () => { seen.invalidated++ } } } } } as any
  await forceRefresh(ctx)
  assert.equal(seen.refresh, 1); assert.equal(seen.invalidated, 1); assert.equal(seen.toasts[0].variant, "success")
})

test("forceRefresh 失败：error toast、不 invalidate", async () => {
  const seen: any = { toasts: [], invalidated: 0 }
  const ctx = { location: {},
    client: { rpc: () => ({ refresh: async () => ({ ok: false, errors: ["boom"] }) }) },
    ui: { toast: { show: (o: any) => seen.toasts.push(o) } },
    data: { location: { integration: { invalidate: () => { seen.invalidated++ } } } } } as any
  await forceRefresh(ctx)
  assert.equal(seen.invalidated, 0); assert.equal(seen.toasts[0].variant, "error")
})

test("非空态：dialog.select 收到 'Force refresh' + mod+r 的 action", async () => {
  let captured: any
  const ctx = { location: {},
    data: { location: { integration: { list: () => [{ id: "acme", name: "Acme", connections: [], metadata: { source: "opencode-providers" } }] } } },
    ui: { dialog: { select: async (o: any) => { captured = o; return undefined } } } } as any
  await connectProviders(ctx)
  const action = captured.actions.find((a: any) => a.title === "Force refresh")
  assert.equal(action.bind, "mod+r"); assert.equal(action.selection, "none")
})

test("空态：confirm 确认后触发 forceRefresh（评审 D）", async () => {
  const seen: any = { refresh: 0 }
  const ctx = { location: {},
    data: { location: { integration: { list: () => [], invalidate: () => {} } } },
    client: { rpc: () => ({ refresh: async () => { seen.refresh++; return { ok: true, providers: 0, models: 0, source: "network", fetchedAt: 1 } } }) },
    ui: { dialog: { confirm: async () => true }, toast: { show: () => {} } } } as any
  await connectProviders(ctx)
  assert.equal(seen.refresh, 1)
})
```
- [ ] **Step 2: 跑测试确认失败** — Run: `node --test tests/connect.test.ts` — Expected: FAIL。
- [ ] **Step 3: 实现**（import `../rpc.ts`；加 `forceRefresh` 与上述 `actions`/空态分支）。
- [ ] **Step 4: 跑测试确认通过** — Run: `node --test tests/connect.test.ts` — Expected: PASS。
- [ ] **Step 5: TUI 入口打包检查** — Run: `npx --yes esbuild plugin/opencode-providers/tui.ts --bundle --platform=node --format=esm --external:@opencode/plugin/tui --outfile=dist/providers-tui.js` — Expected: `Done in`。
- [ ] **Step 6: 提交**
```bash
git add plugin/opencode-providers/view/connect.ts tests/connect.test.ts
git commit -m "feat(tui): /connect-providers 加强制刷新（mod+r + 空态入口）"
```

---

### Task 6: 技能 CLI 改分文件 + `sync`（重算 revision）+ 段校验

**Files:**
- Modify: `.opencode/skills/opencode-providers-registry/scripts/registry.mjs`
- Test: `tests/registry-cli.test.ts`（整体重写）

**Interfaces（CLI）：**
- 命令：`list / search / show / validate / sync / add-provider / add-model / add-shared-model`；通用 `--root <registry 目录>`（默认仓库 `registry/`）、`--json`。
- `revision` = 对 `providers/**` 与 `models/**` 所有文件（不含 `index.json`）按 posix 相对路径排序后 `sha256(rel + "\0" + content + "\0")`（`node:crypto`）。
- `sync` = 重算 `revision` + 重写 `index.json`（`providers` 排序）。
- 任何写命令结束后自动 `sync` 语义（重算 + 重写）。
- `validate` = 聚合过 `parseRegistry` + `index.json` 的 providers 集合 == `providers/*/` 实际目录 + 重算 revision == 存储值。
- **段校验**：`base`/`--lab`/`--key`/`--id` 一律按 `/` 拆段，**逐段**套 `ID_PATTERN`（`^[A-Za-z0-9][A-Za-z0-9._-]*$`）；任一段非法即报错（RF5）。
- **保留现有校验（评审 C）**：`--baseurl` 必须是合法 http(s) URL；同一 `baseURL` 已被别家占用时**报错**，加 `--force` 放行（现状见旧 `registry.mjs:415-421`，不得静默丢失）。
- 源文件格式：`JSON.stringify(x, null, 2) + "\n"`（幂等）。

- [ ] **Step 1: 写失败测试** `tests/registry-cli.test.ts`：建临时 registry 树，`spawnSync` 跑 CLI：
  - `list`/`search`/`show` 正确；`show` 只吐单家。
  - `add-provider` 建 `providers/<id>/{provider,models}.json` 且 `index.json` 追加 id、`revision` 改变、`validate` 退出码 0。
  - 重复 `add-provider` id / 重复 `add-model` key → 退出码 1 且文件不变。
  - `add-model --base deepseek/deepseek-v4.1-flash` 只写 `base`+`modelID`。
  - `add-shared-model --lab deepseek --key foo` 写 `models/deepseek/foo.json`。
  - **C**：`add-provider --baseurl <已被占用的 URL>` → 退出码 1；同一命令加 `--force` → 成功。
  - **RF5**：`add-provider --id 'a:b'` → 退出码 1，含「非法」。
  - `sync`：手改子文件后跑 `sync`，`validate` 退出码 0；不跑 `sync` 直接 `validate` → 退出码 1（revision 不一致）。
  - 格式化幂等：`sync` 两次，文件字节不变（替代旧 `formatRegistry` 复刻用例）。
- [ ] **Step 2: 跑测试确认失败** — Run: `node --test tests/registry-cli.test.ts` — Expected: FAIL。
- [ ] **Step 3: 实现 CLI**（读写分文件；`index.json` providers 排序；`revision` 重算；段校验）。
- [ ] **Step 4: 跑测试确认通过** — Run: `node --test tests/registry-cli.test.ts` — Expected: PASS。
- [ ] **Step 5: 用 CLI 定稿随仓 `revision`** — Run: `node .opencode/skills/opencode-providers-registry/scripts/registry.mjs sync && node .opencode/skills/opencode-providers-registry/scripts/registry.mjs validate` — Expected: 退出码 0。
- [ ] **Step 6: 提交**
```bash
git add .opencode/skills/opencode-providers-registry/scripts/registry.mjs tests/registry-cli.test.ts registry/index.json
git commit -m "feat(skill): CLI 改分文件 + sync/段校验，自动维护 index.json/revision"
```

---

### Task 7: 文档收口 + CI + 破坏性变更说明

**Files:**
- Modify: `.opencode/skills/opencode-providers-registry/SKILL.md`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/opencode-plugin-provider-no-config.md`
- Modify: `CHANGELOG.md`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: SKILL.md**：源结构改分文件；CLI 命令加 `sync` 与 `--root`；强制刷新说明；保留「禁止读整份」与 Questions 模板；删除 `formatRegistry` 表述。
- [ ] **Step 2: AGENTS.md**：改第 4 行、技能段（137-144 行）里 `registry/registry.json` 描述为分文件/manifest/revision；删「`formatRegistry` 逐字节复刻」。
- [ ] **Step 3: README.md**：改 7-8 行（目录树）、112 行（改法说明）、169 行（schema 说明改为「校验以 CLI `validate` 为准」）；55 行示例 URL **改指** `registry/index.json`（与 `DEFAULT_REGISTRY_URL` 一致，评审 E）。
- [ ] **Step 4: `docs/opencode-plugin-provider-no-config.md`**：更新 315/321（缓存键示例）、389/410（注册表结构）、496-509（探针 URL 说明）。
- [ ] **Step 5: CHANGELOG.md**：在 `[Unreleased]` 记「破坏性变更：注册表改分文件 + 运行期聚合；插件默认地址改 `registry/index.json`；旧版本（≤0.1.0）拉旧地址 404 → 沿用缓存、不再更新，需升级」。
- [ ] **Step 6: CI**：`ci.yml` 第 28 行用例名改掉旧路径，并在 `node --test` 后加：
```yaml
      - name: 注册表源一致性（分文件 → 聚合 + index/revision）
        run: node .opencode/skills/opencode-providers-registry/scripts/registry.mjs validate
```
- [ ] **Step 7: 本地复跑** — Run: `node --test` 与 `node .opencode/skills/opencode-providers-registry/scripts/registry.mjs validate` — Expected: 都通过。
- [ ] **Step 8: 提交**
```bash
git add .opencode/skills/opencode-providers-registry/SKILL.md AGENTS.md README.md docs CHANGELOG.md .github/workflows/ci.yml
git commit -m "docs+ci: 同步分文件注册表、sync 校验与破坏性变更说明"
```

---

### Task 8: 端到端验证

- [ ] **Step 1: 全量单测** — Run: `node --test` — Expected: 全绿。
- [ ] **Step 2: CLI validate** — Run: `node .opencode/skills/opencode-providers-registry/scripts/registry.mjs validate` — Expected: 退出码 0。
- [ ] **Step 3: server 入口打包** — Run: `npx --yes esbuild plugin/opencode-providers/index.ts --bundle --platform=node --format=esm --outfile=dist/providers-server.js` — Expected: `Done in`。
- [ ] **Step 4: TUI 入口打包** — Run: `npx --yes esbuild plugin/opencode-providers/tui.ts --bundle --platform=node --format=esm --external:@opencode/plugin/tui --outfile=dist/providers-tui.js` — Expected: `Done in`。
- [ ] **Step 5: 真机冒烟（部署后）** — Run: `pwsh -NoProfile -File .\install.ps1 -Local` 然后 `node scripts/smoke-api.mjs` — Expected: 集成/模型与迁移前一致；TUI `/connect-providers` 弹窗按 `mod+r`（Ctrl+R）→ 成功 toast。
- [ ] **Step 6: 收尾** — `git status` 确认无残留临时文件（含 `%TEMP%` 探针/克隆清理）。

---

## Self-Review

- **Spec coverage**：§3→T2；§4（manifest/revision）→T1/T2/T6；§5（base 路径引用）→T1/T2/T6；§6（运行期聚合+缓存+失败语义）→T3；§7（强制刷新）→T4/T5；§8（CLI）→T6；§9（迁移，含 schema.json/README/docs）→T2/T7；§10（测试+CI）→T1/T3/T4/T5/T6/T7；§11（风险）→ Review Focus；§12（影响文件清单）→ 各 Task Files。
- **Review Focus → 测试映射**：RF1 → `tests/aggregate.test.ts`（字段非法跳过）；RF2 → `tests/source.test.ts`（304+坏缓存重建）；RF3 → `tests/aggregate.test.ts` + `tests/source.test.ts`（base 缺失/404 跳过）；RF4 → `tests/setup.test.ts`（失败不清 state/reload）；RF5 → `tests/registry-cli.test.ts`（`:` 段被拒）。
- **Type consistency**：`Manifest`/`parseManifest`/`buildRegistry`（判别联合）/`LoadRegistryResult.warnings`/`RegistryCacheEntry.revision`/`registryRpc`/`forceRefresh` 在各 Task 间同名同形。
- **Proportion**：以签名 + 断言为主，未逐行转写实现。