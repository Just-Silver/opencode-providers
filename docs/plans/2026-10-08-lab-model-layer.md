# lab 模型层（canon / provider 两层 + 三选一）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让注册表的 CLI 强制走「lab 模型层」——`add-model`/`add-provider` 必须显式声明模型来源（`--lab` 建 canon / `--base` 复用 / `--inline` 本家独有），并自动维护 canon（建、清、体检）。

**Architecture:** 只在**技能 CLI**（`.opencode/skills/opencode-providers-registry/scripts/`，`.mjs`，不发布）与 `registry/` 数据层改动；新增一个纯函数 `resolveModelSource` 统一「来源三选一」的判定与两个 spec（canon / provider 层）的构造，`add-provider` / `add-model` 都走它。`registry/schema.ts` 不改（已支持 `base` 叠加与「内联必须自带 limit」）。

**Tech Stack:** Node ≥ 24（原生类型擦除、`node --test`）、零新依赖、JSON；技能是 `.mjs`（CI 在 ubuntu 跑 `node --test`）。

**Spec:** `docs/specs/2026-10-08-lab-model-layer-design.md`

## Global Constraints

- **破坏性**：不兼容旧命令语义、不迁移旧行为。`add-model` 不给来源 = 报错。
- **最小字段铁律**：模型只写 `name` / `modelID` / `limit` / `variants` / `base` / `input`；其余（`keyLabel`/`cost`/`tools`/`env`/`apiKey`…）一律不写。
- 路径段（供应商 id / lab / canon key）必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$`；`--base` 必须恰好 `<lab>/<model>` 两段。
- `limit` 要写就写全：`--context` 与 `--output` 同时给。
- `registry/index.json` 与 `revision` 由 CLI 维护；写命令落盘前一律先 `parseTree` 校验。
- **测试不变量**：测试禁止写死随仓数据（供应商 id / 模型 key / `keyLabel` 文案 / 模型数）——期望值从 `tests/helpers/shipped.ts` 推导（见 AGENTS.md「运行与验证」）。
- 每个 commit 前 `node --test` 全绿；提交信息用**中文**。
- 技能改动受 **writing-skills Iron Law**：没先跑失败基线，不许改技能（Task 6 的第一个步骤就是基线）。
- 本次**不发 npm 版本**（`files` 白名单只有 `plugin/**` + CHANGELOG，技能与 CLI 不发布）。

## Review Focus

1. `--lab <lab>` 且该 canon 已存在 → **必须报错并提示改用 `--base`**（不得静默覆盖已有 canon 的参数）。
2. `--base` 同时给了 `--context/--output`（转售商被限流、limit 更小）→ limit 写 **provider 层覆盖**，canon **不动**。
3. 删除的**最后一个引用者** → 该 canon **自动删除**；若删完**仍有别家引用** → **不能删**。
4. `--lab` / `--base` / `--inline` **给了不止一个** → 报错（而不是让某个悄悄胜出）。
5. `--lab-key` 与供应商 key 不同（如 canon `kimi/k3`、provider key `kimi-k3`）→ canon 文件名用 `--lab-key`，provider 侧 key 不变。

---

### Task 1: 模型来源三选一（`resolveModelSource`）+ `add-model` 走它

**Files:**
- Modify: `.opencode/skills/opencode-providers-registry/scripts/lib/cli.mjs`（`BOOLEAN_FLAGS` 加 `inline`）
- Modify: `.opencode/skills/opencode-providers-registry/scripts/lib/spec.mjs`（新增 `resolveModelSource`）
- Modify: `.opencode/skills/opencode-providers-registry/scripts/lib/commands-write.mjs`（`commandAddModel`）
- Test: `tests/registry-cli.test.ts`

**Interfaces:**
- Produces: `resolveModelSource(tree, flags, { key })` →
  `{ canon: { ref: string, spec: object } | undefined, providerSpec: object }`
  其中 `canon` 仅在 `--lab` 时存在；`providerSpec` 始终含 `base`（`--lab`/`--base`）或为内联完整 spec（`--inline`）。
- Consumes: `buildModelSpec`、`requireShared`、`checkId`、`checkBaseRef`、`lastOf`、`CliError`（均已在 lib 内）。

- [ ] **Step 1: Write the failing tests**

在 `tests/registry-cli.test.ts` 新增（沿用既有 `freshRoot()` + 锚点常量）：

```ts
test("add-model 不带来源 → 报错（破坏性：取消默认内联）", () => {
  const root = freshRoot()
  const result = cli(["add-model", "--provider", ANCHOR_ID, "--key", "x", "--context", "1", "--output", "1"], root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /必须指定模型来源/)
})

test("add-model --lab 建 canon，provider 只写 base", () => {
  const root = freshRoot()
  const result = cli(
    ["add-model", "--provider", ANCHOR_ID, "--key", "kimi-k3", "--lab", "kimi",
     "--model-name", "Kimi K3", "--context", "1048576", "--output", "131072", "--input", "text,image"],
    root,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readJson(file(root, "models", "kimi", "kimi-k3.json")), {
    name: "Kimi K3",
    limit: { context: 1048576, output: 131072 },
    input: ["text", "image"],
  })
  assert.deepEqual(readJson(file(root, "providers", ANCHOR_ID, "models.json"))["kimi-k3"], { base: "kimi/kimi-k3" })
  assert.equal(cli(["validate"], root).status, 0)
})

test("add-model --lab 撞已存在的 canon → 报错并提示 --base", () => {
  const root = freshRoot()
  const result = cli(["add-model", "--provider", ANCHOR_ID, "--key", "dup", "--lab", "anchor", "--lab-key", "base-model", "--context", "1", "--output", "1"], root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /已存在.*--base anchor\/base-model/)
})

test("add-model --lab-key 与 key 不同 → canon 用 lab-key，provider 用 key", () => {
  const root = freshRoot()
  const result = cli(["add-model", "--provider", ANCHOR_ID, "--key", "kimi-k3", "--lab", "kimi", "--lab-key", "k3", "--context", "100", "--output", "10"], root)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readJson(file(root, "providers", ANCHOR_ID, "models.json"))["kimi-k3"], { base: "kimi/k3" })
})

test("add-model --base + limit → limit 写在 provider 层（覆盖），canon 不动", () => {
  const root = freshRoot()
  const before = readJson(file(root, "models", "anchor", "base-model.json"))
  const result = cli(["add-model", "--provider", ANCHOR_ID, "--key", "capped", "--base", ANCHOR_BASE, "--context", "1", "--output", "1"], root)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readJson(file(root, "providers", ANCHOR_ID, "models.json")).capped, { base: ANCHOR_BASE, limit: { context: 1, output: 1 } })
  assert.deepEqual(readJson(file(root, "models", "anchor", "base-model.json")), before)
})

test("add-model 给了不止一个来源 → 报错", () => {
  const root = freshRoot()
  const result = cli(["add-model", "--provider", ANCHOR_ID, "--key", "z", "--lab", "solo", "--inline", "--context", "1", "--output", "1"], root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /只能给一个/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/registry-cli.test.ts`
Expected: FAIL —「必须指定模型来源」等断言不匹配（当前无来源时会走内联、或报 limit 缺失）。

- [ ] **Step 3: Add `inline` to `BOOLEAN_FLAGS`**

`cli.mjs`：`const BOOLEAN_FLAGS = new Set(["json", "force", "help", "strict", "inline"])`。

- [ ] **Step 4: Implement `resolveModelSource` in `spec.mjs`**

签名与要点（分支逻辑见下，body 由实现者按 spec 写）：

```js
/**
 * 解析「模型来源」三选一：--lab（建 canon）/ --base（复用）/ --inline（本家独有）。
 * 恰好给一个；返回 { canon?, providerSpec }。canon 仅在 --lab 时存在。
 */
export function resolveModelSource(tree, flags, { key }) { /* … */ }
```

- `--lab`：`checkId(lab)`；`canonKey = lastOf(flags,"lab-key") ?? key`（过 `checkId`）；`ref = `${lab}/${canonKey}``；
  `tree.shared.has(ref)` → 抛 `共享模型 "${ref}" 已存在，请改用 --base ${ref} 复用`；
  `canon.spec = buildModelSpec(flags, { key: canonKey, allowBase: false })`；
  `providerSpec = { base: ref }`，若 `--model-id` 给定且 ≠ `key` 则加 `modelID`。
- `--base`：`checkBaseRef(base)` + `requireShared(tree, base)`；`providerSpec = buildModelSpec(flags, { key, allowBase: true })`（`--context/--output` 会落进 provider 层）。
- `--inline`：`providerSpec = buildModelSpec(flags, { key, allowBase: false })`（没 limit 会由既有逻辑报错）。
- 计数 0 → `必须指定模型来源：--lab <lab>（建 canon）/ --base <lab>/<model>（复用）/ --inline（本家独有）`；>1 → `--lab / --base / --inline 只能给一个`。

- [ ] **Step 5: Wire `commandAddModel` to it**

`commands-write.mjs`：`ADD_MODEL_FLAGS` 加 `"lab"`, `"lab-key"`, `"inline"`；
在**重复 key 校验之后**调 `resolveModelSource(tree, flags, { key })`；
若 `canon` 存在则 `shared = new Map([...tree.shared, [canon.ref, canon.spec]])` 并 `parseTree({ ...tree, providers, shared })`，落盘 `writeJsonFile(sharedModelPath(root, canon.ref), canon.spec)`；
`nextModels[key] = providerSpec`；随后照旧写 `providers/<id>/models.json` + `syncManifest`。
新增 `console.log` 一行说明走了哪条路（如 `✓ 已建共享模型 "kimi/kimi-k3" 并让 "r4-coder/kimi-k3" 引用它`）。

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/registry-cli.test.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add .opencode/skills/opencode-providers-registry/scripts/lib tests/registry-cli.test.ts
git commit -m "技能CLI：add-model 强制模型来源三选一（--lab/--base/--inline），--lab 建 canon"
```

---

### Task 2: `add-provider` 的**首个模型**同样走三选一

**Files:**
- Modify: `.opencode/skills/opencode-providers-registry/scripts/lib/commands-write.mjs`（`commandAddProvider`）
- Test: `tests/registry-cli.test.ts`

**Interfaces:**
- Consumes: `resolveModelSource`（Task 1）、`sharedModelPath`（`store.mjs`）。

- [ ] **Step 1: Write the failing tests**

```ts
test("add-provider 不带来源 → 报错", () => {
  const root = freshRoot()
  const result = cli(["add-provider", "--id", "np", "--name", "NP", "--model", "m", "--context", "1", "--output", "1"], root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /必须指定模型来源/)
})

test("add-provider --lab 建 canon + provider 引用", () => {
  const root = freshRoot()
  const result = cli(
    ["add-provider", "--id", "np", "--name", "NP", "--baseurl", "https://api.np.test/v1",
     "--model", "glm-5", "--lab", "zhipu", "--model-name", "GLM-5", "--context", "200000", "--output", "32000"],
    root,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readJson(file(root, "providers", "np", "models.json")), { "glm-5": { base: "zhipu/glm-5" } })
  assert.deepEqual(readJson(file(root, "models", "zhipu", "glm-5.json")), { name: "GLM-5", limit: { context: 200000, output: 32000 } })
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

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/registry-cli.test.ts`
Expected: FAIL（`add-provider` 仍未强制来源）。

- [ ] **Step 3: Wire `commandAddProvider`**

`ADD_PROVIDER_FLAGS` 加 `"lab"`, `"lab-key"`, `"inline"`；用 `resolveModelSource(tree, flags, { key: modelKey })` 取代原来的 `base` + `buildModelSpec` 组合；canon 落盘同 Task 1；`parseTree` 时把 `shared` 合进去。

- [ ] **Step 4: 更新受影响的既有用例**

现有用 `add-model` / `add-provider` 但没给来源的用例补上 `--inline`（如「软提示」用例、《I1》用例的 `--provider ANCHOR_ID` 分支）；`--base` 的用例不用改。

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test`
Expected: PASS（全量）。

- [ ] **Step 6: Commit**

```bash
git add .opencode/skills/opencode-providers-registry/scripts/lib tests/registry-cli.test.ts
git commit -m "技能CLI：add-provider 首个模型同样三选一"
```

---

### Task 3: 删除后**自动清理无引用的 canon**

**Files:**
- Modify: `.opencode/skills/opencode-providers-registry/scripts/lib/commands-write.mjs`（`commandRemoveProvider` / `commandRemoveModel`）
- Test: `tests/registry-cli.test.ts`

**Interfaces:**
- Consumes: `sharedModelPath`、`removeEmptyDir`（`spec.mjs`）。

- [ ] **Step 1: Write the failing tests**

```ts
test("remove-model：删掉最后一个引用者时，canon 一并删除", () => {
  const root = freshRoot()
  assert.equal(cli(["remove-model", "--provider", ANCHOR_ID, "--key", ANCHOR_BASE_ONLY], root).status, 0)
  assert.equal(existsSync(file(root, "models", "anchor", "base-model.json")), false)
  assert.equal(cli(["validate"], root).status, 0)
})

test("remove-model：仍有别家引用时，canon 保留", () => {
  const root = freshRoot()
  // 让 command-code 也引用 anchor/base-model（锚点供应商之外的第二家）
  assert.equal(cli(["add-model", "--provider", "command-code", "--key", "shared-too", "--base", ANCHOR_BASE], root).status, 0)
  assert.equal(cli(["remove-model", "--provider", ANCHOR_ID, "--key", ANCHOR_BASE_ONLY], root).status, 0)
  assert.ok(existsSync(file(root, "models", "anchor", "base-model.json")), "仍有引用者，canon 必须保留")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/registry-cli.test.ts`
Expected: FAIL（canon 目前不会被清理；第二个用例的 `existsSync` 断言当前也会 PASS，但第一个会 FAIL）。

- [ ] **Step 3: Implement cleanup**

在 `commandRemoveProvider` / `commandRemoveModel` 落盘 `syncManifest` 之后：
`const orphans = [...tree.shared.keys()].filter((ref) => !providers.some((p) => Object.values(p.models).some((m) => m.base === ref)))`
→ 对每个 orphan `rmSync(sharedModelPath(root, ref), { force: true })` + `removeEmptyDir(join(root, "models", lab))`，并打印 `✓ 清理无人引用的共享模型 "<ref>"`。
（注意：删的是**新的** `shared` 集合里、且不在 `providers` 引用里的 ref；`tree` 是删除前的树，要用更新后的 `providers` 重新计算。）

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add .opencode/skills/opencode-providers-registry/scripts/lib tests/registry-cli.test.ts
git commit -m "技能CLI：删除供应商/模型后自动清理无人引用的 canon"
```

---

### Task 4: `check` 增加「重复家族」提醒

**Files:**
- Modify: `.opencode/skills/opencode-providers-registry/scripts/lib/commands-read.mjs`（`commandCheck`）
- Test: `tests/registry-cli.test.ts`

**Interfaces:**
- Consumes: `findIdenticalShared` 同款「可比字段」比较（把 `comparableFields` / `sameValue` 从 `spec.mjs` 导出并复用，避免两份逻辑）。

- [ ] **Step 1: Write the failing test**

```ts
test("check：两个 canon 参数完全相同 → 提醒（重复家族）", () => {
  const root = freshRoot()
  const spec = readJson(file(root, "models", "anchor", "base-model.json"))
  assert.equal(cli(["add-shared-model", "--lab", "solo", "--key", "dup", "--model-name", spec.name, "--context", String(spec.limit.context), "--output", String(spec.limit.output)], root).status, 0)
  const warn = cli(["check"], root)
  assert.equal(warn.status, 0, warn.stderr)
  assert.match(warn.stdout, /参数完全相同的共享模型/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/registry-cli.test.ts`
Expected: FAIL（无此提醒）。

- [ ] **Step 3: Implement the rule**

`commandCheck` 里遍历 `tree.shared` 两两比较 `comparableFields`，相同 → `warnings.push('共享模型 "A" 与 "B" 参数完全相同（可能是重复家族；确认后可用 remove-shared-model 删一个）')`。`--strict` 时提醒即失败（沿用既有语义）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add .opencode/skills/opencode-providers-registry/scripts/lib tests/registry-cli.test.ts
git commit -m "技能CLI：check 提醒参数完全相同的两个 canon（重复家族）"
```

---

### Task 5: 数据迁移 —— `kimi-k3` 提升为 `kimi/kimi-k3`

**Files:**
- Modify: `registry/models/kimi/kimi-k3.json`（新建）、`registry/providers/r4-coder/models.json`、`registry/index.json`（由 CLI 自动重写）

**Interfaces:**
- Consumes: Task 1 的 CLI（`add-shared-model` 已存在；本任务用 `add-shared-model` + `set-model --base` 组合完成，或 `remove-model` + `add-model --lab`）。

- [ ] **Step 1: 迁移**

```bash
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs add-shared-model \
  --lab kimi --key kimi-k3 --model-name "Kimi K3" --context 1048576 --output 131072 \
  --variant 'low:{"reasoningEffort":"low"}' --variant 'high:{"reasoningEffort":"high"}' --variant 'max:{"reasoningEffort":"max"}' \
  --input text,image,video
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs set-model \
  --provider r4-coder --key kimi-k3 --base kimi/kimi-k3 --unset name,limit,variants,input
```

- [ ] **Step 2: 验证**

Run: `node .opencode/skills/opencode-providers-registry/scripts/registry.mjs check && node .opencode/skills/opencode-providers-registry/scripts/registry.mjs validate && node --test`
Expected: 全绿；`show r4-coder` 里 `kimi-k3` 只剩 `{ "base": "kimi/kimi-k3" }`。

- [ ] **Step 3: Commit**

```bash
git add registry
git commit -m "注册表：kimi-k3 提升为共享模型 kimi/kimi-k3（r4-coder 改为 base 引用）"
```

---

### Task 6: 技能 `SKILL.md` 改写（含 writing-skills 的 RED/GREEN）

**Files:**
- Modify: `.opencode/skills/opencode-providers-registry/SKILL.md`

**Interfaces:**
- Consumes: Task 1–4 的 CLI 语义。

- [ ] **Step 1（RED）：跑基线**

用**未改动**的 SKILL.md 跑一个压力场景（`subagent`，给一个「给已有供应商加一个全新模型」的任务 + 真实可用 CLI）：记录 agent 的实际行为（是否直读 `registry/**`、是否问家族标签、有没有自己编 lab、是不是直接内联）。
**把偏差逐条记下来**（这是改技能的依据，不进仓库）。

- [ ] **Step 2（GREEN）：改 SKILL.md**

1. 铁律改写：删掉「单家独有…一律内联」→ 改为「**lab 造的模型一律 `--lab` 建 canon；只有本家独有/无可归属 lab 才 `--inline`**」。
2. **新增提问分支**（`search` 未命中任何 canon/家族时必问）：

   ```
   header: 家族标签（lab）
   question: 这个模型归属的 lab（家族标签）id 是什么？
             （决定 canon 落在 models/<lab>/<model>.json；没有可归属的 lab 就选「本家独有」）
   options:
     - 本家独有（--inline）
     - <新建 lab，请 Type your own 填 lab id，如 kimi>
   ```
   命中 canon → **不问**，直接 `--base`。
3. 路线 C 措辞：「命中内联模型 → 先提升为共享」改为「命中**别家内联** → 提示可能需要提升为 canon」。
4. 命令示例里的 `add-*` 全部补上来源标志；`--lab-key` 的说明。

- [ ] **Step 3（GREEN 验证）：重跑同场景**

同一个任务、同样的技能（改动后）：agent **应当问家族标签**并走 `--lab`（或 `--base` 命中）。若仍不问 → 回 Step 2 收紧措辞。

- [ ] **Step 4（REFACTOR）：补漏**

把基线里出现的合理化说法（如「只有一家用就内联」）写进技能的「常见错误 / 红线」。

- [ ] **Step 5: Commit**

```bash
git add .opencode/skills/opencode-providers-registry/SKILL.md
git commit -m "技能：改为 lab 模型层（一律建 canon；新增家族标签提问分支）"
```

---

### Task 7: 文档同步

**Files:**
- Modify: `AGENTS.md`（技能一节的能力描述 + 「最小字段铁律」里改为三选一）
- Modify: `CONTRIBUTING.md`（「注册表维护」一节）
- Modify: `CHANGELOG.md`（`[Unreleased]` 里记一条 Changed/Fixed）

- [ ] **Step 1: 改三处文档**

- `AGENTS.md` 技能段：把「路由 A/B/C」更新为「`add-*` 来源三选一」；把「单家独有…内联」改成新铁律；登记 `docs/specs/2026-10-08-lab-model-layer-design.md` 与 `docs/plans/2026-10-08-lab-model-layer.md`（文档地图里 `docs/specs/`、`docs/plans/` 已是条目，确认无需新增行）。
- `CONTRIBUTING.md` 注册表维护：补三选一与自动清理的说明。
- `CHANGELOG.md` `[Unreleased]` → `### Changed`：破坏性——`add-model`/`add-provider` 必须声明模型来源；`### Added`：`check` 重复家族提醒、删除自动清理 canon。

- [ ] **Step 2: 验证 + 提交**

Run: `node --test && node scripts/changelog.mjs check`
Expected: 全绿（版本未变，CHANGELOG 顶部仍是当前版本小节）。

```bash
git add AGENTS.md CONTRIBUTING.md CHANGELOG.md
git commit -m "文档：lab 模型层（三选一 / 自动清理 / 提问分支）"
```

---

## Self-Review

**Spec coverage：**
- 决策 1–5（身份/modelID、默认建家族、`--inline` 例外、override-only、lab 自定）→ Task 1/2/6 的实现与提问模板。
- CLI 表（三选一 + `--lab-key` + limit 归属 + 自动清理 + `check` 守护）→ Task 1/2/3/4。
- 技能变更 1–4 → Task 6。
- 迁移 → Task 5。
- 测试策略 → 各任务的测试步骤（并保持「不写死随仓数据」）。
- 文档 → Task 7。

**Gaps / 明确不做：** `set-model` 不支持「顺手建 canon」（要建 canon 用 `add-shared-model` 或 `add-model --lab`）——spec 未要求，YAGNI。

**Type consistency：** `resolveModelSource(tree, flags, { key }) → { canon?, providerSpec }` 在 Task 1 定义、Task 2 复用；canon ref 形状统一为 `` `${lab}/${canonKey}` ``。

**Review Focus 覆盖：** ①→Task 1 测试（撞车）；②→Task 1 测试（base+limit）；③→Task 3 测试；④→Task 1 测试（多来源）；⑤→Task 1 测试（lab-key）。
