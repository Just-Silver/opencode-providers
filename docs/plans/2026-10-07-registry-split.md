# registry 拆分（分供应商文件 + 运行期聚合 + 强制刷新）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把注册表从单文件改成「按供应商分目录的 JSON 源」，插件运行期聚合 + kv 缓存（6h TTL），并在 `/connect-providers` 弹窗加「强制刷新」。

**Architecture:** 源 = `registry/index.json`（manifest）+ `registry/providers/<id>/{provider,models}.json` + `registry/models/<lab>/<model>.json`。插件 `source.ts` 拉 manifest，用其 `revision` 做「无变化短路」，变了就并发拉各子文件、聚合成**与现有 `Registry` 完全同形**的对象，过 `parseRegistry` 后写 kv。强制刷新经服务端 RPC（纯 JSON Schema 定义，零 `@opencode/*` 依赖）触发绕过 TTL 的重拉 + `provider/integration.reload()`。

**Tech Stack:** TypeScript（Node ≥24 原生类型擦除）、Node `node --test`、零新依赖、JSON；opencode 2.0.x 插件 API（transform/reload/rpc）。

**Spec:** `docs/specs/2026-10-07-registry-split-design.md`

## Global Constraints

- Node ≥ 24（`node --test` 直接跑 `.ts`）；**零新依赖**（不引 TOML/解析库）。
- 源文件只用 **JSON**；聚合给插件/缓存的 body 必须是 `{ schemaVersion, models, providers }`。
- **server 入口及其 import 的模块不得 import 任何 `@opencode/*`**（`index.ts` / `rpc.ts` / `registry/*`）；TUI 入口可。
- 相对导入必须带显式扩展名（`./rpc.ts`）。
- TUI 入口**不写 JSX**（`tui.ts` 保持 `.ts`）。
- 路径段（供应商 id / lab / model）必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$`（禁 `/ \ : * ? " < > |` 与空白）。
- 缓存键 `registry-cache:<index.json url>`；TTL = `DEFAULT_TTL_MS`（6h）。
- 聚合对象**必须过 `parseRegistry` 才写缓存**。
- 提交信息用**中文**；每个 commit 前 `node --test` 全绿。
- 迁移不得改变已注册结果：`command-code`/`r4-coder` 的 `keyLabel`、模型 `modelID`/`limit`/`variants` 原样保留。

## Review Focus

1. manifest 改了、但某个供应商子文件坏掉 → **跳过该家**、其余照常注册（不是整份失败）。
2. `revision` 未变、但缓存 body 已损坏 → **回退重建**，不得把坏 body 当缓存返回。
3. 某家 `models.json` 的 `base` 指向不存在的 `models/<lab>/<model>.json` → **跳过该家**并 warn。
4. 强制刷新时网络失败 → 返回 `{ ok:false, errors }`，且**不清空**已注册的 provider（保留旧 `state`）。
5. 路径段含 Windows 非法字符（如 `:`）→ CLI **报错拒绝**，避免 checkout 失败。

---

### Task 1: `registry/aggregate.ts`（manifest 解析 + 聚合，纯逻辑）

**Files:**
- Create: `plugin/opencode-providers/registry/aggregate.ts`
- Test: `tests/aggregate.test.ts`

**Interfaces:**
- Consumes: `SUPPORTED_SCHEMA_VERSION` from `./schema.ts`（纯常量，已有）。
- Produces:
  ```ts
  export interface Manifest { readonly schemaVersion: number; readonly revision: string; readonly providers: readonly string[] }
  export type ParseManifestResult = { ok: true; manifest: Manifest } | { ok: false; errors: readonly string[] }
  export function parseManifest(input: unknown): ParseManifestResult
  export interface BuildRegistryResult {
    readonly ok: boolean
    readonly registry?: { schemaVersion: number; models: Record<string, unknown>; providers: Record<string, Record<string, unknown>> }
    readonly warnings: readonly string[]
    readonly errors: readonly string[]
  }
  export async function buildRegistry(manifest: Manifest, readJson: (relativePath: string) => Promise<unknown>): Promise<BuildRegistryResult>
  ```
- 约定：`buildRegistry` 读取 `providers/<id>/provider.json`、`providers/<id>/models.json`，以及每个被引用的 `models/<base>.json`（`base` 形如 `<lab>/<model>`）。

- [ ] **Step 1: 写失败测试** `tests/aggregate.test.ts`

```ts
import assert from "node:assert/strict"
import test from "node:test"
import { buildRegistry, parseManifest } from "../plugin/opencode-providers/registry/aggregate.ts"

const manifest = { schemaVersion: 1, revision: "sha256:r1", providers: ["acme", "broken"] }

function reader(files: Record<string, unknown>) {
  return async (path: string) => {
    if (!(path in files)) throw new Error(`404 ${path}`)
    return files[path]
  }
}

test("parseManifest 接受合法、拒绝非法", () => {
  assert.equal(parseManifest(manifest).ok, true)
  assert.equal(parseManifest({ schemaVersion: 2, revision: "x", providers: [] }).ok, false)
  assert.equal(parseManifest({ schemaVersion: 1, revision: "", providers: [] }).ok, false)
  assert.equal(parseManifest({ schemaVersion: 1, revision: "x", providers: [1] }).ok, false)
})

test("buildRegistry 组装 provider + 按需拉 base", async () => {
  const files = {
    "providers/acme/provider.json": { name: "Acme", package: "pkg", baseURL: "https://acme.example/v1" },
    "providers/acme/models.json": { m: { base: "deepseek/deepseek-v4.1-flash" } },
    "models/deepseek/deepseek-v4.1-flash.json": { limit: { context: 10, output: 2 } },
    "providers/broken/provider.json": { name: "Broken", package: "pkg" },
    "providers/broken/models.json": { m: { base: "missing/model" } },
  }
  const result = await buildRegistry(manifest, reader(files))
  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(result.registry!.providers), ["acme"], "坏家被跳过")
  assert.ok(result.warnings.some((w) => w.includes("broken")))
  assert.deepEqual(Object.keys(result.registry!.models), ["deepseek/deepseek-v4.1-flash"])
})

test("全坏 → ok:false", async () => {
  const result = await buildRegistry({ ...manifest, providers: ["broken"] }, reader({}))
  assert.equal(result.ok, false)
  assert.ok(result.errors.length > 0)
})
```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test tests/aggregate.test.ts` — Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `aggregate.ts`** — `parseManifest` 校验 `schemaVersion === SUPPORTED_SCHEMA_VERSION`、`revision` 非空字符串、`providers` 为字符串数组。`buildRegistry` 按 `[...providers].sort()` 遍历：读 `provider.json`/`models.json`（非普通对象 → warn 跳过）；收集 `models.json` 里各 `spec.base`（字符串），逐个 `readJson("models/" + base + ".json")`，任一失败 → warn 跳过该家；否则 `providers[id] = { ...providerJson, models: modelsJson }`、`models[base] = sharedJson`。组装完若 `providers` 为空 → `{ ok:false, errors:["no providers could be loaded"], warnings }`。

- [ ] **Step 4: 跑测试确认通过** — Run: `node --test tests/aggregate.test.ts` — Expected: PASS。

- [ ] **Step 5: 提交**
```bash
git add plugin/opencode-providers/registry/aggregate.ts tests/aggregate.test.ts
git commit -m "feat(registry): 新增分文件聚合器 aggregate.ts"
```

---

### Task 2: 迁移 registry 源为分文件（含 `index.json`），改写随仓注册表测试

**Files:**
- Create: `registry/index.json`、`registry/providers/command-code/provider.json`、`registry/providers/command-code/models.json`、`registry/providers/r4-coder/provider.json`、`registry/providers/r4-coder/models.json`、`registry/models/deepseek/deepseek-v4.1-flash.json`
- Delete: `registry/registry.json`
- Modify: `tests/registry.test.ts`

**Interfaces:**
- Consumes: `buildRegistry`（Task 1）、`parseRegistry`（现有 `registry/schema.ts`）。
- Produces: 迁移后的数据树；`index.json` 形如 `{ "schemaVersion": 1, "revision": "sha256:…", "providers": ["command-code","r4-coder"] }`。

- [ ] **Step 1: 写数据文件**（内容照搬现有单文件，**不改字段**）
  - `providers/command-code/provider.json` = `{ "name": "Command Code", "package": "@opencode/ai/providers/openai-compatible", "baseURL": "https://api.commandcode.ai/provider/v1", "keyLabel": "Paste Command Code API key" }`
  - `providers/command-code/models.json` = `{ "deepseek-v4.1-flash": { "base": "deepseek/deepseek-v4.1-flash", "modelID": "deepseek/deepseek-v4.1-flash" } }`
  - `providers/r4-coder/provider.json` = `{ "name": "R4 Coder", "package": "@opencode/ai/providers/openai-compatible", "baseURL": "https://api.r4.codes/v1", "keyLabel": "Paste R4 Coder API key" }`
  - `providers/r4-coder/models.json` = `{ "deepseek-v4.1-flash": { "base": "deepseek/deepseek-v4.1-flash" } }`
  - `models/deepseek/deepseek-v4.1-flash.json` = 现有顶层 `deepseek-v4.1-flash` 对象原样（name/family/limit/tools/input/output/variants）。
  - `index.json` 的 `revision` 由 Task 6 的 CLI 生成；此处先写占位 `"sha256:placeholder"`，Task 6 会重算（或本步手算）。删除 `registry/registry.json`。

- [ ] **Step 2: 改写 `tests/registry.test.ts`** 为「读分文件 → buildRegistry → parseRegistry」并断言原参数

```ts
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { parseManifest, buildRegistry } from "../plugin/opencode-providers/registry/aggregate.ts"
import { parseRegistry } from "../plugin/opencode-providers/registry/schema.ts"

const root = new URL("../registry/", import.meta.url)
const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, root), "utf8"))
const manifest = parseManifest(read("index.json"))
if (!manifest.ok) throw new Error(manifest.errors.join("\n"))

test("随仓分文件聚合后通过 schema 校验，且两家参数原样", async () => {
  const built = await buildRegistry(manifest.manifest, async (rel) => read(rel))
  assert.equal(built.ok, true)
  const parsed = parseRegistry(built.registry)
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("\n"))
  if (!parsed.ok || !built.ok) return
  const providers = built.registry!.providers
  assert.deepEqual(Object.keys(providers).sort(), ["command-code", "r4-coder"])
  assert.equal((providers["command-code"] as any).baseURL, "https://api.commandcode.ai/provider/v1")
  assert.equal((providers["command-code"] as any).models["deepseek-v4.1-flash"].modelID, "deepseek/deepseek-v4.1-flash")
  assert.equal((providers["r4-coder"] as any).models["deepseek-v4.1-flash"].modelID, undefined, "默认 = key")
  assert.deepEqual(built.registry!.models["deepseek/deepseek-v4.1-flash"], read("models/deepseek/deepseek-v4.1-flash.json"))
})
```

- [ ] **Step 3: 跑测试** — Run: `node --test tests/registry.test.ts` — Expected: PASS。
- [ ] **Step 4: 全量回归** — Run: `node --test` — Expected: 除 `source.test.ts` / `setup.test.ts`（Task 3/4 才改）外通过；若它们因数据迁移失败，本步允许暂时 FAIL，进入 Task 3。
- [ ] **Step 5: 提交**
```bash
git add registry tests/registry.test.ts
git rm registry/registry.json
git commit -m "refactor(registry): 迁移为按供应商分文件 + manifest"
```

---

### Task 3: 重写 `registry/source.ts`（manifest 取数 + revision 短路 + force）

**Files:**
- Modify: `plugin/opencode-providers/registry/source.ts`
- Test: `tests/source.test.ts`（整体重写）

**Interfaces:**
- Consumes: `parseManifest`/`buildRegistry`（Task 1）、`parseRegistry`。
- Produces：
  ```ts
  export const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/Just-Silver/opencode-providers/main/registry/index.json"
  export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000
  export interface RegistryCacheEntry { readonly etag?: string; readonly revision?: string; readonly fetchedAt: number; readonly body: string }
  export interface LoadRegistryOptions { store; fetch; url?; now?; ttlMs?; timeoutMs?; force? }
  export type LoadRegistryResult =
    | { ok: true; registry: Registry; source: "cache"|"network"|"stale-cache"; fetchedAt: number; warnings: readonly string[] }
    | { ok: false; errors: readonly string[] }
  export async function loadRegistry(options: LoadRegistryOptions): Promise<LoadRegistryResult>
  ```

- [ ] **Step 1: 写失败测试** `tests/source.test.ts`（假 fetch 按 URL 返回 manifest / 分文件）
  - 用例：① 新鲜缓存不打网络；② `force` 绕过 TTL；③ manifest 请求带 `If-None-Match`，304 保留旧 body 且只刷新 `fetchedAt`；④ **revision 未变 → 不重拉子文件**（断言 fetch 次数 == 1）；⑤ revision 变化 → 重拉并写缓存；⑥ 网络失败回退 stale；⑦ **revision 未变但缓存 body 损坏 → 重建**（回到 Review Focus 2）；⑧ 某家子文件 404 → 跳过该家、其余注册成功并带 warnings（Review Focus 3）。
  - 关键断言示例（④）：
    ```ts
    const cached = { revision: "sha256:r1", fetchedAt: NOW - 10_000_000, body: AGGREGATE_JSON }
    const { fetch, calls } = filesFetch({ "index.json": manifestOf("sha256:r1") })
    const result = await loadRegistry({ store, fetch, now: () => NOW, ttlMs: 1000 })
    assert.equal(result.ok, true); assert.equal(result.source, "cache")
    assert.equal(calls.length, 1, "只打 manifest，不重拉子文件")
    ```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test tests/source.test.ts` — Expected: FAIL。
- [ ] **Step 3: 实现 `source.ts`** — 流程见 spec §6；`readJson(rel)` = `fetch(new URL(rel, url).toString(), { headers:{accept:"application/json","user-agent":"opencode-providers"}, signal: AbortSignal.timeout(timeoutMs) })`，非 2xx 或坏 JSON 抛错。`revision` 短路：`cached.revision === manifest.revision` 且 `parseBody(cached.body).ok` → 仅刷新 `fetchedAt`，`source:"cache"`。成功写缓存 `{ etag, revision, fetchedAt, body: JSON.stringify(rawRegistry) }`，`warnings` 来自 `buildRegistry`。
- [ ] **Step 4: 跑测试确认通过** — Run: `node --test tests/source.test.ts` — Expected: PASS。
- [ ] **Step 5: 提交**
```bash
git add plugin/opencode-providers/registry/source.ts tests/source.test.ts
git commit -m "feat(registry): source 改为 manifest 取数 + revision 短路 + force"
```

---

### Task 4: 服务端接线（模块级 state + RPC refresh + reload）

**Files:**
- Create: `plugin/opencode-providers/rpc.ts`
- Modify: `plugin/opencode-providers/index.ts`
- Test: `tests/setup.test.ts`（改假 fetch 为树；加 refresh 用例）

**Interfaces:**
- Consumes: `loadRegistry`（Task 3）。
- Produces：
  ```ts
  // rpc.ts（纯 JSON Schema，零依赖）
  export const registryRpc = { id: "opencode-providers", methods: { refresh: { input:{...}, output:{...} } }, events: {} } as const
  ```
  `refresh` handler 返回 `{ ok, providers?, models?, source?, fetchedAt?, errors? }`。
  `SetupContextLike` 增补：`rpc.register`、`provider.reload()`、`integration.reload()`。

- [ ] **Step 1: 写/改测试** `tests/setup.test.ts`
  - `withFetch` 改成按「树」（manifest + 分文件）返回；保留原有两条注册断言（keyLabel/activation/baseURL/modelID/limit/variants 不变）。
  - 新增：注册后调用 `state.ctx.rpc.refresh()`（假 `rpc.register` 捕获 handlers），断言：绕过 TTL 重拉、调用了 `integration.reload`/`provider.reload`、返回 `{ ok: true, providers: 2 }`。
  - 新增（Review Focus 4）：refresh 时 fetch 全 404 → 返回 `{ ok:false, errors }` 且 `state.providers` 仍为旧的 2 条。

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test tests/setup.test.ts` — Expected: FAIL。
- [ ] **Step 3: 实现 `rpc.ts`**（按 spec §7 的 schema）**与改 `index.ts`**：模块级 `state={registry?}`；`setup` 里 `loadRegistry` 后设置 state，**始终**注册两个 transform（回调读 `state.registry`，为空则 no-op），再 `ctx.rpc.register(registryRpc, { refresh })`；`refresh` 内 `force:true` 重拉，成功才覆盖 state 并 `reload`，失败原样返回错误。
- [ ] **Step 4: 跑测试确认通过** — Run: `node --test tests/setup.test.ts` — Expected: PASS。
- [ ] **Step 5: 提交**
```bash
git add plugin/opencode-providers/rpc.ts plugin/opencode-providers/index.ts tests/setup.test.ts
git commit -m "feat(plugin): 服务端 RPC 强制刷新 + 模块级 state/reload"
```

---

### Task 5: TUI `/connect-providers` 弹窗加「强制刷新」（按钮 + `mod+r`）

**Files:**
- Modify: `plugin/opencode-providers/view/connect.ts`
- Test: `tests/connect.test.ts`

**Interfaces:**
- Consumes: `registryRpc`（Task 4）、`ctx.client.rpc`、`ctx.ui.toast`、`ctx.data.location.integration.invalidate`。
- Produces:
  ```ts
  export async function forceRefresh(ctx: Plugin.Context): Promise<void>
  ```
  首个 `dialog.select` 加 `actions: [{ title: "Force refresh", bind: "mod+r", selection: "none", onTrigger: () => forceRefresh(ctx) }]`。

- [ ] **Step 1: 写失败测试** `tests/connect.test.ts`（假 ctx）
```ts
import assert from "node:assert/strict"
import test from "node:test"
import { forceRefresh } from "../plugin/opencode-providers/view/connect.ts"

test("forceRefresh 调 rpc.refresh、invalidate、成功 toast", async () => {
  const seen: any = { refresh: 0, toasts: [], invalidated: 0 }
  const ctx = {
    location: {},
    client: { rpc: () => ({ refresh: async () => { seen.refresh++; return { ok: true, providers: 2, models: 2, source: "network", fetchedAt: 1 } } }) },
    ui: { toast: { show: (o: any) => seen.toasts.push(o) } },
    data: { location: { integration: { invalidate: () => { seen.invalidated++ } } } },
  } as any
  await forceRefresh(ctx)
  assert.equal(seen.refresh, 1)
  assert.equal(seen.invalidated, 1)
  assert.equal(seen.toasts[0].variant, "success")
})

test("forceRefresh 失败 → error toast、不 invalidate", async () => {
  const seen: any = { toasts: [], invalidated: 0 }
  const ctx = {
    location: {},
    client: { rpc: () => ({ refresh: async () => ({ ok: false, errors: ["boom"] }) }) },
    ui: { toast: { show: (o: any) => seen.toasts.push(o) } },
    data: { location: { integration: { invalidate: () => { seen.invalidated++ } } } },
  } as any
  await forceRefresh(ctx)
  assert.equal(seen.invalidated, 0)
  assert.equal(seen.toasts[0].variant, "error")
})
```

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test tests/connect.test.ts` — Expected: FAIL。
- [ ] **Step 3: 实现**：加 `import { registryRpc } from "../rpc.ts"` 与 `forceRefresh`；在 `connectProviders` 首个 `select` 的 options 后加上述 `actions`。
- [ ] **Step 4: 跑测试确认通过** — Run: `node --test tests/connect.test.ts` — Expected: PASS。
- [ ] **Step 5: 入口语法检查** — Run: `npx --yes esbuild plugin/opencode-providers/tui.ts --bundle --platform=node --format=esm --external:@opencode/plugin/tui --outfile=dist/providers-tui.js` — Expected: `Done in`（无报错）。
- [ ] **Step 6: 提交**
```bash
git add plugin/opencode-providers/view/connect.ts tests/connect.test.ts
git commit -m "feat(tui): /connect-providers 加强制刷新动作（mod+r）"
```

---

### Task 6: 技能 CLI 改写为分文件 + 自动维护 `index.json` + `revision`

**Files:**
- Modify: `.opencode/skills/opencode-providers-registry/scripts/registry.mjs`
- Test: `tests/registry-cli.test.ts`（整体重写）

**Interfaces:**
- Produces（CLI 行为）：命令 `list/search/show/validate/add-provider/add-model/add-shared-model`；通用 `--root <registry 目录>`（默认仓库 `registry/`）、`--json`。
  - `validate` = 聚合后过 `parseRegistry` + `index.json` 的 id 集合 == `providers/*/` 实际目录集合 + 重算 `revision` 与存储值一致。
  - `revision` = 对 `providers/**` 与 `models/**` 所有文件按相对路径排序后 `sha256(rel + "\0" + content + "\0")`（`node:crypto`）。
  - 任何写命令结束后重算 `revision` 并重写 `index.json`。

- [ ] **Step 1: 写失败测试** `tests/registry-cli.test.ts`：建临时 registry 树（`index.json` + 两个供应商），用 `spawnSync` 跑 CLI：
  - `list`/`search`/`show` 输出正确、`show` 只吐单家。
  - `add-provider` 建 `providers/<id>/provider.json`+`models.json` 且 `index.json` 的 `providers` 追加该 id、`revision` 改变；落盘后 `validate` 退出码 0。
  - 重复 `add-provider` id / 重复 `add-model` key → 退出码 1 且文件不变（冲突）。
  - `add-model --base <lab>/<model>` 只写 `base` + `modelID`。
  - `add-shared-model --lab deepseek --key <model>` 写 `models/deepseek/<model>.json`。
  - **Review Focus 5**：`add-provider --id 'a:b'` → 退出码 1，含「非法」。
  - `validate` 在「手改子文件但没重算 revision」时 → 退出码 1（`revision` 不一致）。

- [ ] **Step 2: 跑测试确认失败** — Run: `node --test tests/registry-cli.test.ts` — Expected: FAIL。
- [ ] **Step 3: 实现 CLI**：读写分文件（`JSON.stringify(x, null, 2) + "\n"`）；`index.json` 的 `providers` 始终排序；`revision` 如上重算；路径段用安全正则校验（复用现有 `ID_PATTERN` 思路）。
- [ ] **Step 4: 跑测试确认通过** — Run: `node --test tests/registry-cli.test.ts` — Expected: PASS。
- [ ] **Step 5: 用 CLI 重算随仓 `revision`** — Run: `node .opencode/skills/opencode-providers-registry/scripts/registry.mjs validate` — Expected: 通过（若 Task 2 的占位 revision 不一致，先 `add-shared-model` 触发重写或由实现提供 `validate --fix`；否则手动重算写入）。
- [ ] **Step 6: 提交**
```bash
git add .opencode/skills/opencode-providers-registry/scripts/registry.mjs tests/registry-cli.test.ts registry/index.json
git commit -m "feat(skill): 注册表 CLI 改为分文件 + 自动维护 index.json/revision"
```

---

### Task 7: 文档与 CI

**Files:**
- Modify: `.opencode/skills/opencode-providers-registry/SKILL.md`
- Modify: `AGENTS.md`
- Modify: `docs/opencode-plugin-provider-no-config.md`（如涉及取数描述）
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: CLI `validate`（Task 6）、`source.ts` 的新 URL/缓存（Task 3）。

- [ ] **Step 1: 更新 SKILL.md**：源结构改成分文件说明；CLI 命令改为 `--root`；强制刷新说明；保留「禁止读整份」与 Questions 模板。
- [ ] **Step 2: 更新 `AGENTS.md`** 技能段与注册表结构描述（index.json/manifest/revision/分文件）。
- [ ] **Step 3: CI 加一步**（`.github/workflows/ci.yml`，在 `node --test` 后）
```yaml
      - name: 注册表源一致性（分文件 → 聚合 + index/revision）
        run: node .opencode/skills/opencode-providers-registry/scripts/registry.mjs validate
```
- [ ] **Step 4: 本地复跑** — Run: `node --test` 然后 `node .opencode/skills/opencode-providers-registry/scripts/registry.mjs validate` — Expected: 都通过。
- [ ] **Step 5: 提交**
```bash
git add .opencode/skills/opencode-providers-registry/SKILL.md AGENTS.md docs .github/workflows/ci.yml
git commit -m "docs+ci: 同步分文件注册表与一致性校验"
```

---

### Task 8: 端到端验证

**Files:**
- 无（验证任务）

- [ ] **Step 1: 全量单测** — Run: `node --test` — Expected: 全绿。
- [ ] **Step 2: server 入口打包** — Run:
```bash
npx --yes esbuild plugin/opencode-providers/index.ts --bundle --platform=node --format=esm --outfile=dist/providers-server.js
```
Expected: `Done in`（server 入口无外部依赖，不需要 `--external`）。
- [ ] **Step 3: TUI 入口打包** — Run:
```bash
npx --yes esbuild plugin/opencode-providers/tui.ts --bundle --platform=node --format=esm --external:@opencode/plugin/tui --outfile=dist/providers-tui.js
```
Expected: `Done in`。
- [ ] **Step 4: raw 可访问性（推送后）** — Run: `curl -fsSL https://raw.githubusercontent.com/Just-Silver/opencode-providers/main/registry/index.json` — Expected: 200 且含 `revision`/`providers`。
- [ ] **Step 5: 真机冒烟（本地部署后）** — Run: `pwsh -NoProfile -File .\install.ps1 -Local` 然后 `node scripts/smoke-api.mjs` — Expected: 集成/模型与迁移前一致；再在 TUI `/connect-providers` 弹窗按 `mod+r`（Ctrl+R）看到成功 toast。
- [ ] **Step 6: 提交（如 dist/smoke 有产物则按需）** — `git status` 确认无残留临时文件。

---

## Self-Review

- **Spec coverage**：§3 源结构 → Task 2；§4 manifest/revision → Task 1/2/6；§5 base → Task 1/2/6；§6 运行期聚合+缓存 → Task 3；§7 强制刷新 → Task 4/5；§8 CLI → Task 6；§9 迁移 → Task 2；§10 测试/CI → Task 1/3/4/5/6/7；§11 风险 → Review Focus。
- **Step scan**：每步一个可判定动作。
- **Type consistency**：`Manifest`/`buildRegistry`/`parseManifest`/`LoadRegistryResult.warnings`/`registryRpc`/`forceRefresh` 在各 Task 间名称一致。
- **Review Focus**：5 条各落到 Task 3（②③⑦⑧）、Task 4（④）、Task 6（⑤）。
- **Proportion**：以签名 + 断言为主，未逐行转写实现。
