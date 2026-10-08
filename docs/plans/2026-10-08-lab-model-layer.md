# lab 模型层（canon / provider 两层 + 三选一）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让注册表的 CLI 强制走「lab 模型层」——`add-model`/`add-provider` 必须显式声明模型来源（`--lab` 建 canon / `--base` 复用 / `--inline` 本家独有），并自动维护 canon（建、清、体检）。

**Architecture:** 只在**技能 CLI**（`.opencode/skills/opencode-providers-registry/scripts/`，`.mjs`，不发布）与 `registry/` 数据层改动；新增一个纯函数 `resolveModelSource` 统一「来源三选一」的判定与两个 spec（canon / provider 层）的构造，`add-provider` / `add-model` 都走它。`registry/schema.ts` 不改（已支持 `base` 叠加与「内联必须自带 limit」）。

**Tech Stack:** Node ≥ 24（原生类型擦除、`node --test`）、零新依赖、JSON；技能是 `.mjs`（CI 在 ubuntu 跑 `node --test`）。

**Spec:** `docs/specs/2026-10-08-lab-model-layer-design.md`

## Global Constraints

- **破坏性**：不兼容旧命令语义、不迁移旧行为。`add-model` / `add-provider` 不给来源 = 报错。
- **最小字段铁律**：模型只写 `name` / `modelID` / `limit` / `variants` / `base` / `input`；其余（`keyLabel`/`cost`/`tools`/`env`/`apiKey`…）一律不写。
- 路径段（供应商 id / lab / canon key）必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$`；`--base` 必须恰好 `<lab>/<model>` 两段。
- `limit` 要写就写全：`--context` 与 `--output` 同时给。
- **`resolveModelSource` 必须在既有「身份/重复/URL」校验之后调用**：否则既有用例（重复 key 期望 `/已存在模型/`、重复 id 期望 `/已存在/`、baseURL 占用）会先撞上「必须指定模型来源」而变红。
- **落盘顺序**：`解析 → 组装树 → parseTree 校验 → 写文件（含 canon）→ syncManifest`。**删/建 canon 文件必须发生在 `syncManifest` 之前**（`revision` 是 `models/**`+`providers/**` 的哈希，`store.mjs:81-92`）。
- `registry/index.json` 与 `revision` 由 CLI 维护；写命令落盘前一律先 `parseTree` 校验。
- **测试不变量**：测试**禁止写死随仓数据**（供应商 id / 模型 key / lab / `keyLabel` 文案 / 模型数）——期望值从 `tests/helpers/shipped.ts` 的 `registryView(root)` 推导（见 AGENTS.md「运行与验证」）。新建 canon 的测试用**动态 lab**（`freshLab`），别写 `kimi`（Task 6 之后它就是随仓数据）。
- 每个 commit 前 `node --test` 全绿；提交信息用**中文**。
- 技能改动受 **writing-skills Iron Law**：没先跑失败基线（Task 1），不许改技能（Task 7）。
- 本次**不发 npm 版本**（`files` 白名单只有 `plugin/**` + CHANGELOG）；**`plugin/**` 不改 → 跳过 esbuild 打包冒烟**。

## Review Focus

1. `--lab <lab>` 且该 canon 已存在 → **必须报错并提示改用 `--base`**（不得静默覆盖）。
2. `--base` 同时给了 `--context/--output` → limit 写 **provider 层覆盖**，canon **不动**。
3. 删除的**最后一个引用者** → 该 canon **自动删除**；若删完**仍有别家引用** → **不能删**。
4. `--lab` / `--base` / `--inline` **给了不止一个** → 报错（不让某个悄悄胜出）。
5. `--lab-key` 与供应商 key 不同 → canon 文件名用 `--lab-key`，provider 侧 key 不变；且 `--model-id` **只进 provider 层**、**不进 canon**。

---

### Task 1: 技能基线（RED）—— 未改动的技能跑一遍压力场景

**Files:** 无（**不改任何仓库文件**；产物只用于 Task 7）

> 这一步必须**最先**执行：Task 2 起 CLI 会变成「三选一必填」，届时「旧技能 + 旧 CLI」的真实基线就再也取不到了。

- [ ] **Step 1: 先把注册表复制到临时目录**（保证基线**碰不到**真实 `registry/`）

```powershell
$base = "C:\Users\13178\AppData\Local\Temp\opencode\lab-baseline"
Remove-Item -Recurse -Force $base -ErrorAction SilentlyContinue
Copy-Item -Recurse "D:\Code\Projects\Agents\opencode-providers\registry" $base
```

- [ ] **Step 2: 派一个全新上下文的 subagent**：给它一个「给已有供应商 `r4-coder` 新增一个**全新模型**（无任何现成共享模型）→ 例如加 `glm-5`」的任务，告诉它按 `.opencode/skills/opencode-providers-registry/SKILL.md` 的技能做，且**所有 CLI 调用都必须带 `--root $base`**（此时 CLI 仍是**旧版**：无 `--lab`/`--inline`，`add-model` 默认内联）。
- [ ] **Step 3: 记录实际偏差**（不进仓库，写进本任务的手记）：是否直读 `registry/**`、是否**问了「家族标签 / lab」**、是否**直接内联**、有没有**自己编造 lab**、命令参数是否多余/缺失。
- [ ] **Step 4: 收尾自查**：`git status --porcelain registry` 必须为空；随后清掉 `$base`。
- [ ] **Step 5: 交回给 Task 7**：Task 7 的 REFACTOR 步骤必须逐条针对这些偏差收紧措辞。

（无 commit。）

---

### Task 2: `add-model` 来源三选一 + `resolveModelSource`

**Files:**
- Modify: `.opencode/skills/opencode-providers-registry/scripts/lib/cli.mjs`（`BOOLEAN_FLAGS` 加 `inline`）
- Modify: `.opencode/skills/opencode-providers-registry/scripts/lib/spec.mjs`（`buildModelSpec` 加 `allowModelID`；新增 `resolveModelSource`；补 `checkBaseRef` 导入）
- Modify: `.opencode/skills/opencode-providers-registry/scripts/lib/commands-write.mjs`（`commandAddModel`）
- Modify: `.opencode/skills/opencode-providers-registry/scripts/registry.mjs`（USAGE 里 `add-model` 一行）
- Test: `tests/registry-cli.test.ts`

**Interfaces:**
- Produces: `resolveModelSource(tree, flags, { key })` → `{ canon: { ref, spec } | undefined, providerSpec: object }`
  - `canon` 仅在 `--lab` 时存在；`providerSpec` 在 `--lab`/`--base` 下含 `base`（`--lab` 下还可能含 `modelID`），`--inline` 下是完整内联 spec。
- Produces: `buildModelSpec(flags, { key, allowBase, allowModelID = true })`（`allowModelID=false` 时不写 `modelID`）。
- Consumes: `requireShared`（`store.mjs`）、`checkId` / `lastOf` / `CliError` / `buildModelSpec`（同文件）。

- [ ] **Step 1: 加测试辅助 `freshLab`**

在 `tests/registry-cli.test.ts` 顶部（`freshRoot` 附近）加：

```ts
/** 选一个随仓没有的 lab 名（动态），避免与未来新增的共享模型撞车。 */
function freshLab(root: string): string {
  const used = new Set(registryView(root).sharedRefs().map((ref) => ref.split("/")[0]))
  for (let i = 0; ; i += 1) {
    const candidate = `zz-lab-${i}`
    if (!used.has(candidate)) return candidate
  }
}
```

- [ ] **Step 2: 写失败测试**

```ts
test("add-model 不带来源 → 报错（破坏性：取消默认内联）", () => {
  const root = freshRoot()
  const result = cli(["add-model", "--provider", ANCHOR_ID, "--key", "x", "--context", "1", "--output", "1"], root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /必须指定模型来源/)
})

test("add-model --lab 建 canon（canon 不含 modelID），provider 只写 base + modelID", () => {
  const root = freshRoot()
  const lab = freshLab(root)
  const result = cli(
    ["add-model", "--provider", ANCHOR_ID, "--key", "k3",
     "--lab", lab, "--lab-key", "km",
     "--model-name", "Kimi K3", "--context", "1048576", "--output", "131072",
     "--input", "text,image", "--model-id", "upstream/k3"],
    root,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readJson(file(root, "models", lab, "km.json")), {
    name: "Kimi K3",
    limit: { context: 1048576, output: 131072 },
    input: ["text", "image"],
  })
  assert.deepEqual(readJson(file(root, "providers", ANCHOR_ID, "models.json")).k3, {
    base: `${lab}/km`,
    modelID: "upstream/k3",
  })
  assert.equal(cli(["validate"], root).status, 0)
})

test("add-model --lab 撞已存在的 canon → 报错并提示 --base", () => {
  const root = freshRoot()
  const result = cli(
    ["add-model", "--provider", ANCHOR_ID, "--key", "dup", "--lab", "anchor", "--lab-key", "base-model",
     "--context", "1", "--output", "1"],
    root,
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /已存在.*--base anchor\/base-model/)
})

test("add-model 给了不止一个来源 → 报错", () => {
  const root = freshRoot()
  const result = cli(
    ["add-model", "--provider", ANCHOR_ID, "--key", "z", "--lab", "solo", "--inline", "--context", "1", "--output", "1"],
    root,
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /只能给一个/)
})

test("add-model --base + limit → limit 写在 provider 层（覆盖），canon 不动", () => {
  const root = freshRoot()
  const before = readJson(file(root, "models", "anchor", "base-model.json"))
  const result = cli(
    ["add-model", "--provider", ANCHOR_ID, "--key", "capped", "--base", ANCHOR_BASE, "--context", "1", "--output", "1"],
    root,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readJson(file(root, "providers", ANCHOR_ID, "models.json")).capped, {
    base: ANCHOR_BASE,
    limit: { context: 1, output: 1 },
  })
  assert.deepEqual(readJson(file(root, "models", "anchor", "base-model.json")), before)
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test tests/registry-cli.test.ts`
Expected:
- 「不带来源」「--lab 建 canon」「撞 canon」「多来源」四个**新用例 FAIL**（当前无来源会走内联或报 limit 缺失、无 `--lab` 选项）。
- 「`--base` + limit」「`--base` 悬空/非法」是**回归保护**——当前**已经通过**，别误判成「改动没生效」。

- [ ] **Step 4: `cli.mjs` 把 `inline` 加进布尔开关**

`const BOOLEAN_FLAGS = new Set(["json", "force", "help", "strict", "inline"])`

- [ ] **Step 5: `spec.mjs` —— `buildModelSpec` 加 `allowModelID`（**不要新增任何导入**）**

- `buildModelSpec` 签名 → `export function buildModelSpec(flags, { key, allowBase, allowModelID = true })`
- 把写 `modelID` 的那两行（原 70-71）包进 `if (allowModelID) { … }`
- `resolveModelSource` 只用**文件内已有**的 `requireShared` / `checkId` / `lastOf` / `CliError` / `buildModelSpec`；**不要**加 `checkBaseRef` 导入（`--base` 的合法性/存在性由 `requireShared` 内部处理）——避免留死代码。

- [ ] **Step 6: `spec.mjs` —— 新增 `resolveModelSource`**

```js
/**
 * 解析「模型来源」三选一：--lab（建 canon）/ --base（复用）/ --inline（本家独有）。
 * 恰好给一个；返回 { canon?, providerSpec }（canon 仅在 --lab 时存在）。
 * 必须在既有的身份/重复校验之后调用。
 */
export function resolveModelSource(tree, flags, { key }) {
  const lab = lastOf(flags, "lab")
  const hasLab = typeof lab === "string" && lab.trim() !== ""
  const hasBase = lastOf(flags, "base") !== undefined
  const hasInline = flags.inline === true || flags.inline === "true"   // 兼容 `--inline=true`
  const count = [hasLab, hasBase, hasInline].filter(Boolean).length
  if (count === 0) {
    throw new CliError(`必须指定模型来源：--lab <lab>（建共享模型）/ --base <lab>/<model>（复用）/ --inline（本家独有）`)
  }
  if (count > 1) throw new CliError(`--lab / --base / --inline 只能给一个`)

  if (hasLab) {
    const ref = `${checkId(lab, "lab")}/${checkId(lastOf(flags, "lab-key") ?? key, "共享模型 key")}`
    if (tree.shared.has(ref)) throw new CliError(`共享模型 "${ref}" 已存在，请改用 --base ${ref} 复用`)
    const canonKey = ref.split("/")[1]
    const canon = buildModelSpec(flags, { key: canonKey, allowBase: false, allowModelID: false })
    const providerSpec = { base: ref }
    const modelId = lastOf(flags, "model-id")
    if (typeof modelId === "string" && modelId.trim() !== "" && modelId !== key) providerSpec.modelID = modelId
    return { canon: { ref, spec: canon }, providerSpec }
  }
  if (hasBase) {
    requireShared(tree, lastOf(flags, "base"))
    return { providerSpec: buildModelSpec(flags, { key, allowBase: true }) }
  }
  return { providerSpec: buildModelSpec(flags, { key, allowBase: false }) }
}
```

（`requireShared` 已在 `spec.mjs` 顶部导入；`checkBaseRef` 由 `requireShared` 内部调用。）

- [ ] **Step 7: `commands-write.mjs` —— `commandAddModel` 走它**

- `ADD_MODEL_FLAGS` 加 `"lab"`, `"lab-key"`, `"inline"`。
- 保持**既有顺序**：`providerId → entry → key → 重复 key 校验`（原 94-105）**之后**，把原 `base + requireShared + buildModelSpec`（原 106-108）换成：

```js
const { canon, providerSpec } = resolveModelSource(tree, flags, { key })
const nextModels = { ...entry.models, [key]: providerSpec }
const providers = tree.providers.map((item) =>
  item.id === providerId ? { id: item.id, provider: item.provider, models: nextModels } : item,
)
const shared = canon ? new Map([...tree.shared, [canon.ref, canon.spec]]) : tree.shared
parseTree({ ...tree, providers, shared })

if (canon) writeJsonFile(sharedModelPath(root, canon.ref), canon.spec)   // 必须在 syncManifest 之前
writeJsonFile(join(providerDir(root, providerId), "models.json"), nextModels)
syncManifest(root)
```

- 从 `store.mjs` 的 import 里补 `sharedModelPath`；从 `spec.mjs` 的 import 里补 `resolveModelSource`。
- 打印走的路：`--lab` → `✓ 已建共享模型 "${canon.ref}" 并让 "${providerId}/${key}" 引用它`；否则沿用原句；末尾照旧 `reportReuseHint(tree, providerSpec)`（只对 `--inline` 有意义，但无害）。

- [ ] **Step 8: `registry.mjs` USAGE —— 改 `add-model` 一行**

把 `add-model` 那两行改为（`--lab`/`--base`/`--inline` 三选一、`--lab-key`）：

```
    node scripts/registry.mjs add-model --provider ID --key KEY \\
        (--lab LAB [--lab-key NAME] | --base lab/model | --inline) \\
        [--model-name 名称] [--model-id 上游id] \\
        [--context N --output N] [--variant id[:settingsJSON]] \\
        [--input text,image,...]
```

- [ ] **Step 9: 修既有用例（否则本任务 commit 后全量 `node --test` 会红）**

`tests/registry-cli.test.ts:586`「软提示：内联参数与某共享模型相同」用的 `add-model` **补 `--inline`**（其余断言不动）。（**行号为改动前**，按用例标题定位。）

- [ ] **Step 10: 跑测试确认通过**

Run: `node --test`
Expected: PASS（全量）。

- [ ] **Step 11: Commit**

```bash
git add .opencode/skills/opencode-providers-registry/scripts tests/registry-cli.test.ts
git commit -m "技能CLI：add-model 强制来源三选一（--lab/--base/--inline），--lab 建 canon"
```

---

### Task 3: `add-provider` 的首个模型同样走三选一

**Files:**
- Modify: `.opencode/skills/opencode-providers-registry/scripts/lib/commands-write.mjs`（`commandAddProvider`）
- Modify: `.opencode/skills/opencode-providers-registry/scripts/registry.mjs`（USAGE 里 `add-provider` 一行）
- Test: `tests/registry-cli.test.ts`

**Interfaces:** Consumes `resolveModelSource`（Task 2）、`sharedModelPath`。

- [ ] **Step 1: 写失败测试**

```ts
test("add-provider 不带来源 → 报错", () => {
  const root = freshRoot()
  const result = cli(["add-provider", "--id", "np", "--name", "NP", "--model", "m", "--context", "1", "--output", "1"], root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /必须指定模型来源/)
})

test("add-provider --lab 建 canon + provider 引用", () => {
  const root = freshRoot()
  const lab = freshLab(root)
  const result = cli(
    ["add-provider", "--id", "np", "--name", "NP", "--baseurl", "https://api.np.test/v1",
     "--model", "glm-5", "--lab", lab, "--model-name", "GLM-5", "--context", "200000", "--output", "32000"],
    root,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readJson(file(root, "providers", "np", "models.json")), { "glm-5": { base: `${lab}/glm-5` } })
  assert.deepEqual(readJson(file(root, "models", lab, "glm-5.json")), { name: "GLM-5", limit: { context: 200000, output: 32000 } })
})

test("add-provider --base 复用已有 canon（只写 base/modelID）", () => {
  const root = freshRoot()
  const result = cli(
    ["add-provider", "--id", "reuse2", "--name", "Reuse2", "--baseurl", "https://api.reuse2.test/v1",
     "--model", "m", "--base", ANCHOR_BASE, "--model-id", "up/m"],
    root,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readJson(file(root, "providers", "reuse2", "models.json")), { m: { base: ANCHOR_BASE, modelID: "up/m" } })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/registry-cli.test.ts`
Expected: 「不带来源」FAIL；「`--lab`」FAIL；「`--base`」是**回归保护**（当前已通过）。

- [ ] **Step 3: `commandAddProvider` 走 `resolveModelSource`**

保持既有顺序（`id` 重复 → `name` → `package` → `baseURL` 占用校验，原 48-66）之后，把原 `modelKey + base + requireShared + buildModelSpec`（原 68-71）换成：

```js
const modelKey = checkId(required(flags, "model", "首个模型 key"), "模型 key")
const { canon, providerSpec } = resolveModelSource(tree, flags, { key: modelKey })
const provider = { name, package: packageName, ...(baseURL === undefined ? {} : { baseURL }) }
const shared = canon ? new Map([...tree.shared, [canon.ref, canon.spec]]) : tree.shared
parseTree({ ...tree, providers: [...tree.providers, { id, provider, models: { [modelKey]: providerSpec } }], shared })

writeJsonFile(join(providerDir(root, id), "provider.json"), provider)
if (canon) writeJsonFile(sharedModelPath(root, canon.ref), canon.spec)   // 必须在 syncManifest 之前
writeJsonFile(join(providerDir(root, id), "models.json"), { [modelKey]: providerSpec })
syncManifest(root)
```

`ADD_PROVIDER_FLAGS` 加 `"lab"`, `"lab-key"`, `"inline"`；末尾 `reportReuseHint(tree, providerSpec)` 保留。

**收尾**：此时 `commands-write.mjs` 里 `requireShared` 的两处调用（原 70、107）都被替换了 → 从 `cli.mjs` 的 import 里**删掉 `requireShared`**（避免死代码）；`sharedModelPath` 已在 Task 2 加入 `store.mjs` 的 import。

- [ ] **Step 4: 修既有用例（5 个成功路径用例补 `--inline`）**

（**以下行号为改动前**，按用例标题定位。）
给下列用例的 `add-provider` 参数补 `--inline`（**其余断言不动**）：
- `:173` `add-provider 建分文件…`（example-prov）
- `:264/:269` `add-provider baseURL 占用 → 报错；--force 放行`（注意：`args` 里加，让首次「占用报错」与 `--force` 放行都带；占用校验在来源解析之前，首断言仍 `/已被供应商/`）
- `:316` `CLI 健壮性…`（aliasprov）
- `:396` `I2：add-provider 未给 --model-name…`（newprov）
- `:405` `能力多选：--input 写 input 模态`（vision）

（`:219` 重复 id、`:276`/`:377` 非法 id 是**失败路径**，在校验更靠前处即报错，无需改。）

- [ ] **Step 5: `registry.mjs` USAGE —— 改 `add-provider` 一行**（同 Task 2 的三选一写法，`--model` 后面同样 `(--lab … | --base … | --inline)`）。

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test`
Expected: PASS（全量）。

- [ ] **Step 7: Commit**

```bash
git add .opencode/skills/opencode-providers-registry/scripts tests/registry-cli.test.ts
git commit -m "技能CLI：add-provider 首个模型同样走来源三选一"
```

---

### Task 4: 删除后自动清理无引用的 canon

**Files:**
- Modify: `.opencode/skills/opencode-providers-registry/scripts/lib/commands-write.mjs`（`commandRemoveProvider` / `commandRemoveModel`）
- Test: `tests/registry-cli.test.ts`

**Interfaces:** Consumes `sharedModelPath`、`removeEmptyDir`（`spec.mjs`，`commands-write.mjs` 已导入）、`dirname`（已导入）。

- [ ] **Step 1: 写失败测试**

```ts
test("remove-model：删掉最后一个引用者 → canon 自动删除并清空 lab 目录", () => {
  const root = freshRoot()
  const lab = freshLab(root)
  assert.equal(
    cli(["add-model", "--provider", ANCHOR_ID, "--key", "solo-ref", "--lab", lab, "--lab-key", "km",
         "--context", "1", "--output", "1"], root).status,
    0,
  )
  assert.ok(existsSync(file(root, "models", lab, "km.json")))

  const removed = cli(["remove-model", "--provider", ANCHOR_ID, "--key", "solo-ref"], root)
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(existsSync(file(root, "models", lab, "km.json")), false)
  assert.equal(existsSync(file(root, "models", lab)), false, "空 lab 目录也要清掉")
  assert.equal(cli(["validate"], root).status, 0)
})

test("remove-model：仍有别家引用 → canon 保留", () => {
  const root = freshRoot()
  // anchor/base-model 同时被 anchor-shared 与 anchor-override 引用；只删一个 → 必须保留
  const removed = cli(["remove-model", "--provider", ANCHOR_ID, "--key", ANCHOR_BASE_ONLY], root)
  assert.equal(removed.status, 0, removed.stderr)
  assert.ok(existsSync(file(root, "models", "anchor", "base-model.json")), "仍有引用者，canon 必须保留")
  assert.equal(cli(["validate"], root).status, 0)
})

test("remove-provider：整家删掉后，仅它引用的 canon 也自动清理", () => {
  const root = freshRoot()
  const lab = freshLab(root)
  assert.equal(
    cli(["add-provider", "--id", "solo-prov", "--name", "S", "--model", "m", "--lab", lab,
         "--context", "1", "--output", "1"], root).status,
    0,
  )
  const removed = cli(["remove-provider", "--id", "solo-prov"], root)
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(existsSync(file(root, "models", lab, "m.json")), false)
  assert.equal(cli(["validate"], root).status, 0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/registry-cli.test.ts`
Expected: 三条均 FAIL（canon 现在不会被清理）。注意第二个用例当前**会通过**（本来就没删）→ 它是「保留」语义的回归保护。

- [ ] **Step 3: 实现清理（**删文件必须在 `syncManifest` 之前**）**

`commandRemoveProvider`：把原「`rmSync(providerDir)` → `syncManifest` → 打印 orphans 提示」（原 268-278）改成：

```js
rmSync(providerDir(root, id), { recursive: true, force: true })
const orphans = [...tree.shared.keys()].filter(
  (ref) => !providers.some((item) => Object.values(item.models).some((model) => model.base === ref)),
)
for (const ref of orphans) {
  const path = sharedModelPath(root, ref)
  rmSync(path, { force: true })
  removeEmptyDir(dirname(path))
}
syncManifest(root)
console.log(`✓ 已删除供应商 "${id}"（${entry.provider.name}，${Object.keys(entry.models).length} 个模型）`)
if (orphans.length > 0) console.log(`  已自动清理无人引用的共享模型：${orphans.join(", ")}`)
```

`commandRemoveModel`：在 `writeJsonFile(models.json)` 之后、`syncManifest` 之前插入同一段孤儿计算与删除（复用上面的 `providers`），打印改为 `已自动清理无人引用的共享模型：…`。

（`sharedModelPath` 已在 Task 2/3 加入 `commands-write.mjs` 的 import；`removeEmptyDir`/`dirname` 已在。）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add .opencode/skills/opencode-providers-registry/scripts tests/registry-cli.test.ts
git commit -m "技能CLI：删除供应商/模型后自动清理无人引用的 canon"
```

---

### Task 5: `check` 增加「重复家族」提醒

**Files:**
- Modify: `.opencode/skills/opencode-providers-registry/scripts/lib/spec.mjs`（导出 `comparableFields`、`sameValue`）
- Modify: `.opencode/skills/opencode-providers-registry/scripts/lib/commands-read.mjs`（`commandCheck` 新增第 8 条）
- Test: `tests/registry-cli.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
test("check：两个 canon 参数完全相同 → 提醒（重复家族）", () => {
  const root = freshRoot()
  const lab = freshLab(root)
  const base = readJson(file(root, "models", "anchor", "base-model.json"))
  assert.equal(
    cli(["add-shared-model", "--lab", lab, "--key", "dup", "--model-name", base.name,
         "--context", String(base.limit.context), "--output", String(base.limit.output)], root).status,
    0,
  )
  const warn = cli(["check"], root)
  assert.equal(warn.status, 0, warn.stderr)
  assert.match(warn.stdout, /参数完全相同的共享模型/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/registry-cli.test.ts`
Expected: FAIL（无此提醒）。

- [ ] **Step 3: 导出比较器**

`spec.mjs`：把 `function comparableFields` → `export function comparableFields`，`const sameValue = …` → `export const sameValue = …`。

- [ ] **Step 4: `commandCheck` 加规则**

`commands-read.mjs` 顶部 import 补 `comparableFields, sameValue`；在「4) 内联…」之后加：

```js
  // 4b) 两个 canon 参数完全相同 → 可能是重复家族
  const sharedEntries = [...tree.shared].map(([ref, model]) => [ref, comparableFields(model)])
  for (let i = 0; i < sharedEntries.length; i += 1) {
    for (let j = i + 1; j < sharedEntries.length; j += 1) {
      if (sameValue(sharedEntries[i][1], sharedEntries[j][1])) {
        warnings.push(`参数完全相同的共享模型："${sharedEntries[i][0]}" 与 "${sharedEntries[j][0]}"（可能重复家族；确认后删其一）`)
      }
    }
  }
```

（`--strict` 下提醒即失败，沿用既有语义，无需另改。）

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add .opencode/skills/opencode-providers-registry/scripts tests/registry-cli.test.ts
git commit -m "技能CLI：check 提醒参数完全相同的两个 canon（重复家族）"
```

---

### Task 6: 数据迁移 —— `kimi-k3` 提升为 `kimi/kimi-k3`

**Files:**
- Add: `registry/models/kimi/kimi-k3.json`（由 CLI 生成）
- Modify: `registry/providers/r4-coder/models.json`、`registry/index.json`（由 CLI 自动重写）

- [ ] **Step 1: 迁移**（`--variant` 的值含双引号 JSON，**必须用 PowerShell 数组 splatting `@args` 传参**，否则本机 PowerShell 会把引号拆开/剥掉，`JSON.parse` 必失败）

```powershell
$a = @(
  "add-shared-model", "--lab", "kimi", "--key", "kimi-k3",
  "--model-name", "Kimi K3", "--context", "1048576", "--output", "131072",
  "--variant", 'low:{"reasoningEffort":"low"}',
  "--variant", 'high:{"reasoningEffort":"high"}',
  "--variant", 'max:{"reasoningEffort":"max"}',
  "--input", "text,image,video"
)
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs @a

node .opencode/skills/opencode-providers-registry/scripts/registry.mjs set-model `
  --provider r4-coder --key kimi-k3 --base kimi/kimi-k3 --unset name,limit,variants,input
```

> 先自检一次 argv 是否带住引号（可选）：`node -e "console.log(process.argv.slice(1))" @('--variant','low:{\"reasoningEffort\":\"low\"}')`。
> 若某些 PowerShell 版本仍丢引号，退路：把上面的 `@a` 写进一个临时 `.mjs`（`spawnSync(process.execPath, [cli, ...argv])`）执行，跑完删掉。

- [ ] **Step 2: 验证**

Run: `node .opencode/skills/opencode-providers-registry/scripts/registry.mjs check && node .opencode/skills/opencode-providers-registry/scripts/registry.mjs validate && node --test`
Expected: `check` 全绿（含 `--strict` 语义无孤儿）；`show r4-coder kimi-k3` = `{ "base": "kimi/kimi-k3" }`；全量测试 PASS（新话：迁移把 `kimi/kimi-k3` 变成**随仓** canon，但测试用 `freshLab`，不受影响）。

- [ ] **Step 3: Commit**

```bash
git add registry
git commit -m "注册表：kimi-k3 提升为共享模型 kimi/kimi-k3（r4-coder 改为 base 引用）"
```

---

### Task 7: 技能 `SKILL.md` 改写（GREEN / REFACTOR）

**Files:**
- Modify: `.opencode/skills/opencode-providers-registry/SKILL.md`

**Interfaces:** Consumes Task 2–5 的 CLI 语义。

- [ ] **Step 1（GREEN）：改 SKILL.md**
  1. **铁律反转**：删掉「单家独有…一律内联」→ 改为「**能说出造它的 lab 的模型，一律 `--lab` 建 canon；只有本家独有/无可归属 lab 才 `--inline`**」。
  2. **新增提问分支**（`search` 未命中任何 canon/家族时**必问**）：

     ```
     header: 家族标签（lab）
     question: 这个模型归属的 lab（家族标签）id 是什么？
               （决定 canon 落在 models/<lab>/<model>.json；没有可归属的 lab 就选「本家独有」）
     options:
       - 本家独有（--inline）
       - <新建 lab，请 Type your own 填 lab id，如 kimi>
     ```
     命中 canon → **不问**，直接 `--base`。
  3. **路线 C 措辞**：「命中内联模型 → 先提升为共享」改为「命中**别家内联** → 提示可能需要提升为 canon」。
  4. **命令示例**：所有 `add-model`/`add-provider` 示例补上 `--lab`/`--base`/`--inline`；补 `--lab-key` 说明。
  5. **REFACTOR**：把 Task 1 基线记录到的偏差（如「只有一家卖就内联」的合理化说法）逐条写进技能的「常见错误 / 红线」。

- [ ] **Step 2（验证）：重跑 Task 1 的同场景**

同一个任务、改动后的技能：agent **应当问家族标签**并走 `--lab`（或 `--base` 命中）。若仍不问 → 回 Step 1 收紧措辞。

- [ ] **Step 3: Commit**

```bash
git add .opencode/skills/opencode-providers-registry/SKILL.md
git commit -m "技能：改为 lab 模型层（一律建 canon；新增家族标签提问分支）"
```

---

### Task 8: 文档同步

**Files:**
- Modify: `AGENTS.md`（技能一节的能力描述 + 「最小字段铁律」→ 三选一）
- Modify: `CONTRIBUTING.md`（「注册表维护」一节）
- Modify: `CHANGELOG.md`（`[Unreleased]`）

- [ ] **Step 1: 改三处文档**

- `AGENTS.md` 技能段：把「路由 A/B/C」更新为「`add-*` 来源三选一」；把「单家独有…内联」改成新铁律；确认文档地图里 `docs/specs/`、`docs/plans/` 条目已覆盖本次两份新文档（已是条目，无需新增行）。
- `CONTRIBUTING.md` 注册表维护：补三选一与「删除自动清理 canon」的说明。
- `CHANGELOG.md` `[Unreleased]` → `### Changed`：破坏性——`add-model`/`add-provider` 必须声明模型来源；`### Added`：`check` 重复家族提醒、删除自动清理 canon。

- [ ] **Step 2: 验证 + 提交**

Run: `node --test && node scripts/changelog.mjs check`
Expected: 全绿（版本未变，CHANGELOG 顶部仍是当前版本小节）。

```bash
git add AGENTS.md CONTRIBUTING.md CHANGELOG.md
git commit -m "文档：lab 模型层（三选一 / 自动清理 / 提问分支）"
```

---

## Self-Review（对照审查意见逐条落实）

**审查 🔴 阻塞项：**
- **B1**（既有 add-model 用例未在 Task 2 内修）→ Task 2 Step 9 就地补 `--inline`；Task 3 Step 4 列全 5 个 add-provider 用例。每个任务自己 Step 都跑全量 `node --test`。
- **B2**（写死 `kimi/kimi-k3`，迁移后必红）→ 改用动态 `freshLab`（Task 2 Step 1），不写任何随仓 lab/key。
- **B3**（`anchor-override` 是第二引用者，误删断言错）→ Task 4 用「新建 canon + 单引用者」验删除、「`anchor/base-model` 仍被 override 引用」验保留。
- **B4**（先 `syncManifest` 后删 canon → revision 失效）→ Task 4 Step 3 明确「删文件在 `syncManifest` 之前」。
- **B5**（写死随仓 id `command-code`）→ Task 4 全部改用 `freshLab` / 锚点，无随仓 id。
- **B6**（正则与文案不一致）→ Task 5 文案与正则统一为「参数完全相同的共享模型」。

**审查 🟡 建议项：** S1→Task 2 的 `allowModelID=false`（canon 不带 modelID，并有断言）；S2→Task 2/3 明确落盘顺序；S3→Task 3 Step 4 列全 5 个用例；S4→基线提前为 **Task 1**（新 CLI 到位前跑）；S5→各 Step 2 标注「哪些是回归保护、哪些此刻才失败」；S6→Task 2/3 各自更新 USAGE；S7→Task 2 Step 5 补 `checkBaseRef` 导入。

**审查 ⚪ Nit：** N1→Task 4 保留用例改为断言「canon 确实还在」的**有效**用例；N2→Global Constraints 写明 `plugin/**` 未改、跳过 esbuild；N3→Task 2 接口写明 `--lab` 下 provider 层**只含 `base`（+ `modelID`）**，不含 `name`/`limit`。

**Spec coverage：** 决策 1–5 → Task 2/3/7；CLI 表（三选一 + `--lab-key` + limit 归属 + 自动清理 + `check` 守护）→ Task 2/3/4/5；技能变更 1–4 → Task 7；迁移 → Task 6；测试策略 → 各任务测试步骤（保持「不写死随仓数据」）；文档 → Task 8。

**Type consistency：** `resolveModelSource(tree, flags, { key }) → { canon?, providerSpec }` 在 Task 2 定义、Task 3 复用；canon ref 统一 `` `${lab}/${canonKey}` ``。

**明确不做：** `set-model` 不支持「顺手建 canon」（要建 canon 用 `add-shared-model` 或 `add-model --lab`）——spec 未要求，YAGNI。

---

## 第二轮复核（针对修订稿）

- 🔴 **N1（PowerShell `--variant` 引号会被拆/剥）** → Task 6 Step 1 改用 **PowerShell 数组 splatting `@args`** 传参 + 一条 argv 自检 + 临时 `.mjs` 退路。
- 🟡 **N2（基线可能污染真实 `registry/`）** → Task 1 先复制到 `%TEMP%` 副本、要求所有 CLI 带 `--root $base`，并加 `git status --porcelain registry` 必须为空 + 清理副本。
- 🟡 **N3（未使用导入）** → Task 2 Step 5 明确**不加** `checkBaseRef` 导入；Task 3 Step 3 收尾**删掉 `commands-write.mjs` 的 `requireShared` 导入**（两处调用都被替换）。Interfaces 里同步删除 `checkBaseRef`。
- ⚪ **N4（行号漂移）** → Task 2 Step 9 / Task 3 Step 4 标注「行号为改动前，按用例标题定位」。
- ⚪ **N5（`--inline=true` 边界）** → `hasInline` 兼容字符串 `"true"`。