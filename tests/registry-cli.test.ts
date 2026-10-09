import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { after } from "node:test"
import { fileURLToPath } from "node:url"

import { registryView, escapeRe, need } from "./helpers/shipped.ts"
import { syncManifest } from "../.opencode/skills/opencode-providers-registry/scripts/lib/store.mjs"

const CLI = fileURLToPath(
  new URL("../.opencode/skills/opencode-providers-registry/scripts/registry.mjs", import.meta.url),
)
const SHIPPED_ROOT = fileURLToPath(new URL("../registry", import.meta.url))

/** 随仓注册表视图（只读）：所有期望值都从它推导。 */
const shipped = registryView(SHIPPED_ROOT)

/** 锚点供应商：固定的测试操作对象，与随仓数据无关。 */
const ANCHOR_ID = "zz-anchor"
const ANCHOR_BASE_ONLY = "anchor-shared"
const ANCHOR_OVERRIDE = "anchor-override"
const ANCHOR_INLINE = "anchor-inline"
const ANCHOR_BASE = "anchor/base-model"
const ANCHOR_LIMIT = { context: 1000, output: 100 }
const ANCHOR_BASE_LIMIT = { context: 500, output: 50 }
const ANCHOR_URL = "https://api.zz-anchor.test/v1"

/** 测试用的临时目录统一登记，收尾清理（别把残留留在机器上）。 */
const TEMP_DIRS: string[] = []
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

/**
 * 复制一份随仓 registry 目录树，再补上一个**锚点供应商**，写坏也不污染仓库。
 *
 * 锚点保证测试永远有稳定的操作对象（「只写 base 的模型」「覆盖 modelID 的模型」「内联模型」、
 * 一条顶层共享模型、一个占用的 baseURL），因此**新增/删除随仓供应商、模型、共享模型时
 * 本文件不需要改一行**。
 */
function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-registry-"))
  TEMP_DIRS.push(dir)
  const root = join(dir, "registry")
  cpSync(SHIPPED_ROOT, root, { recursive: true })
  seedAnchors(root)
  return root
}

/** 只往临时副本里写锚点，不碰随仓注册表。 */
function seedAnchors(root: string) {
  const write = (rel: string, value: unknown) =>
    writeFileSync(join(root, ...rel.split("/")), `${JSON.stringify(value, null, 2)}\n`)

  mkdirSync(join(root, "providers", ANCHOR_ID), { recursive: true })
  mkdirSync(join(root, "models", "anchor"), { recursive: true })
  write("providers/zz-anchor/provider.json", {
    name: "ZZ Anchor",
    package: "@opencode/ai/providers/openai-compatible",
    baseURL: ANCHOR_URL,
  })
  write("providers/zz-anchor/models.json", {
    [ANCHOR_BASE_ONLY]: { base: ANCHOR_BASE },
    [ANCHOR_OVERRIDE]: { base: ANCHOR_BASE, modelID: "upstream/anchor" },
    [ANCHOR_INLINE]: { name: "Anchor Inline", limit: ANCHOR_LIMIT },
  })
  write("models/anchor/base-model.json", { name: "Anchor Base", limit: ANCHOR_BASE_LIMIT })
  // 用 CLI 自己的 sync 重算 revision + 重写 providers 列表（单一事实源，不另写一份算法）
  syncManifest(root)
}

function cli(args: readonly string[], root: string) {
  return spawnSync(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8" })
}

const file = (root: string, ...rel: string[]) => join(root, ...rel)

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function walk(root: string, dir = ""): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir ? join(root, dir) : root, { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walk(root, rel))
    else out.push(rel)
  }
  return out.sort()
}

function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(walk(root).map((rel) => [rel, readFileSync(file(root, ...rel.split("/")), "utf8")]))
}

/** 从注册表目录推导 validate 的汇总计数，新增供应商/模型不需要改测试。 */
function registryCounts(root: string) {
  const view = registryView(root)
  return { providers: view.ids().length, models: view.modelCount(), shared: view.sharedCount() }
}

/** 选一个随仓没有的 lab 名（动态），避免与未来新增的共享模型撞车。 */
function freshLab(root: string): string {
  const used = new Set(registryView(root).sharedRefs().map((ref) => ref.split("/")[0]))
  for (let i = 0; ; i += 1) {
    const candidate = `zz-lab-${i}`
    if (!used.has(candidate)) return candidate
  }
}

test("list 打印供应商与模型，不吐整份 JSON", () => {
  const root = freshRoot()
  const view = registryView(root)
  const result = cli(["list"], root)
  assert.equal(result.status, 0, result.stderr)

  // 每一家都要出现，且带上 id / name / 包 / 模型数
  for (const id of view.ids()) {
    const provider = view.provider(id)
    assert.match(result.stdout, new RegExp(escapeRe(`${id} (${provider.name})`)))
    assert.match(result.stdout, new RegExp(escapeRe(`${view.keys(id).length} 个模型`)))
  }
  // 带 base 的模型行渲染成 `key → modelID … base=…`
  const based = need(view.basedModels()[0], "一个引用了顶层共享模型的模型")
  assert.match(
    result.stdout,
    new RegExp(`- ${escapeRe(based.key)}\\s+→ ${escapeRe(based.spec.modelID ?? based.key)}`),
  )
  assert.match(result.stdout, new RegExp(escapeRe(`base=${based.spec.base}`)))
  // 顶层共享模型也列出来
  for (const ref of view.sharedRefs()) assert.match(result.stdout, new RegExp(escapeRe(ref)))
})

test("list --json：共享模型的引用方按供应商去重（同家多个模型引用同一 canon 只列一次）", () => {
  const root = freshRoot()
  const result = cli(["list", "--json"], root)
  assert.equal(result.status, 0, result.stderr)
  const data = JSON.parse(result.stdout) as { sharedModels: Array<{ ref: string; usedBy: string[] }> }

  // 锚点里 anchor-shared 与 anchor-override 都引用同一 canon → 引用方应只有 zz-anchor 一个
  const shared = data.sharedModels.find((row) => row.ref === ANCHOR_BASE)
  assert.ok(shared, `锚点共享模型 ${ANCHOR_BASE} 应出现在列表里`)
  assert.deepEqual(shared.usedBy, [ANCHOR_ID])
})

test("search 命中供应商名/模型 key；未命中退出码 1", () => {
  const root = freshRoot()
  const view = registryView(root)
  const id = need(view.ids()[0], "至少一家供应商")

  const hit = cli(["search", id], root)
  assert.equal(hit.status, 0, hit.stderr)
  assert.match(hit.stdout, new RegExp(escapeRe(id)))

  const byModel = cli(["search", view.keys(id)[0]!], root)
  assert.equal(byModel.status, 0, byModel.stderr)
  assert.match(byModel.stdout, new RegExp(escapeRe(id)))

  const miss = cli(["search", "does-not-exist"], root)
  assert.equal(miss.status, 1)
  assert.match(miss.stdout, /没有匹配/)
})

test("search 标注命中来源：供应商 id/名称命中带标记，纯模型命中不带", () => {
  const root = freshRoot()

  // 供应商命中：查询就是锚点供应商 id
  const byProvider = cli(["search", ANCHOR_ID], root)
  assert.equal(byProvider.status, 0, byProvider.stderr)
  assert.match(byProvider.stdout, /供应商 id\/名称命中/)

  // 纯模型命中：查询只落在某个模型 key 上（token 不碰供应商 id/名称）
  const modelOnly = ANCHOR_INLINE.replace("anchor-", "")
  const byModel = cli(["search", modelOnly], root)
  assert.equal(byModel.status, 0, byModel.stderr)
  assert.match(byModel.stdout, new RegExp(escapeRe(ANCHOR_INLINE)))
  assert.doesNotMatch(byModel.stdout, /供应商 id\/名称命中/)
})

test("search AND（全 token 命中）匹配：大小写 / 分隔符 / 词序 / modelID 全串都能命中", () => {
  const root = freshRoot()
  const hits = (q: string) => {
    const result = cli(["search", q], root)
    assert.equal(result.status, 0, `${q} → ${result.stderr}`)
    return result.stdout
  }

  // canon ref 是 anchor/base-model：大写 + 下划线（`/`、`_` 与 `-` 等价）
  assert.match(hits("ANCHOR/BASE_MODEL"), new RegExp(escapeRe(ANCHOR_BASE)))
  // 点号分隔也应命中同一 canon
  assert.match(hits("Anchor.Base.Model"), new RegExp(escapeRe(ANCHOR_BASE)))
  // 词序颠倒（token 集合匹配，不是子串匹配）
  assert.match(hits("model anchor"), new RegExp(escapeRe(ANCHOR_BASE)))
  // 上游 modelID 全串（带厂商前缀）命中
  assert.match(hits("UPSTREAM/ANCHOR"), new RegExp(escapeRe(ANCHOR_OVERRIDE)))
  // 宽松召回：命中可能不止一个（多个候选交给用户二次确认）
  const broad = cli(["search", "anchor"], root)
  assert.equal(broad.status, 0, broad.stderr)
  const matched = [ANCHOR_BASE, ANCHOR_BASE_ONLY, ANCHOR_OVERRIDE, ANCHOR_INLINE].filter((token) =>
    broad.stdout.includes(token),
  )
  assert.ok(matched.length >= 2, `「anchor」应召回多个候选，实际：${matched.join(", ")}`)
})

test("search 纯 AND 无兜底：系列词（flash）不跨家族误召；AND 零命中直接「没有匹配」", () => {
  const root = freshRoot()
  // 两个不同家族、共用系列词的模型（昔日 glm 查询因共有 token flash 误召 deepseek）；
  // 家族词用随仓不存在的 zeta/omega，避免与随仓 lab 相撞
  for (const [lab, key] of [
    ["zeta", "zeta-flash"],
    ["omega", "omega-flash"],
  ] as const) {
    const added = cli(
      [
        "add-model",
        "--provider", ANCHOR_ID,
        "--key", key,
        "--lab", lab,
        "--model-name", key,
        "--context", "1048576",
        "--output", "131072",
      ],
      root,
    )
    assert.equal(added.status, 0, added.stderr)
  }

  const zetaRe = /zeta-flash/
  const omegaRe = /omega-flash/

  // AND：查询的家族词必须命中——共有 token flash 不再把 omega 捞回来；大小写不敏感
  for (const q of ["zeta-flash", "ZETA-Flash"]) {
    const hit = cli(["search", q], root)
    assert.equal(hit.status, 0, `${q} → ${hit.stderr}`)
    assert.match(hit.stdout, zetaRe)
    assert.doesNotMatch(hit.stdout, omegaRe)
  }

  // 查询只剩一个系列词 token（AND ≡ OR）：明确找 flash 时全部家族都召回
  const series = cli(["search", "flash"], root)
  assert.equal(series.status, 0, series.stderr)
  assert.match(series.stdout, zetaRe)
  assert.match(series.stdout, omegaRe)

  // 无兜底：AND 零命中直接没有匹配（回退 OR 会靠 flash 又把 omega 捞回来）
  const noFallback = cli(["search", "somevendor/zeta-flash"], root)
  assert.equal(noFallback.status, 1)
  assert.match(noFallback.stdout, /没有匹配/)
})

test("show 单看一个供应商/模型；不存在报错", () => {
  const root = freshRoot()
  const view = registryView(root)
  const id = need(view.ids()[0], "至少一家供应商")

  const provider = cli(["show", id], root)
  assert.equal(provider.status, 0, provider.stderr)
  assert.match(provider.stdout, /"models"/)
  // 只看一家：别的供应商不出现在结果里
  for (const other of view.ids().filter((candidate) => candidate !== id)) {
    assert.doesNotMatch(provider.stdout, new RegExp(`"${escapeRe(other)}"\\s*:`))
  }

  // 覆盖了上游 modelID 的模型：show 要原样打印
  const override = need(view.modelWithModelIDOverride(), "一个覆盖了 modelID 的模型")
  const model = cli(["show", override.id, override.key], root)
  assert.equal(model.status, 0, model.stderr)
  assert.match(model.stdout, new RegExp(`"modelID": "${escapeRe(override.modelID)}"`))

  // 内联模型：show 要打印内联 limit
  const inline = cli(["show", ANCHOR_ID, ANCHOR_INLINE], root)
  assert.equal(inline.status, 0, inline.stderr)
  assert.match(inline.stdout, new RegExp(`"context": ${ANCHOR_LIMIT.context}`))

  // 顶层共享模型也能按 <lab>/<model> 看
  const ref = need(view.sharedRefs()[0], "至少一条顶层共享模型")
  const sharedModel = cli(["show", ref], root)
  assert.equal(sharedModel.status, 0, sharedModel.stderr)
  assert.match(sharedModel.stdout, /"limit"/)

  const missing = cli(["show", "nope"], root)
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /不存在/)
})

test("add-provider 建分文件、index 追加 id、revision 改变、validate 通过", () => {
  const root = freshRoot()
  const before = readJson(file(root, "index.json"))

  const result = cli(
    [
      "add-provider",
      "--id", "example-prov",
      "--name", "Example Provider",
      "--baseurl", "https://api.example-prov.test/v1",
      "--protocol", "chat",
      "--model", "example-chat",
      "--inline",
      "--model-name", "Example Chat",
      "--model-id", "example-chat-v1",
      "--context", "131072",
      "--output", "32768",
      "--variant", 'low:{"reasoningEffort":"low"}',
    ],
    root,
  )
  assert.equal(result.status, 0, result.stderr)

  assert.deepEqual(readJson(file(root, "providers", "example-prov", "provider.json")), {
    name: "Example Provider",
    package: "@opencode/ai/providers/openai-compatible",
    baseURL: "https://api.example-prov.test/v1",
  })
  assert.deepEqual(readJson(file(root, "providers", "example-prov", "models.json")), {
    "example-chat": {
      name: "Example Chat",
      modelID: "example-chat-v1",
      limit: { context: 131072, output: 32768 },
      variants: [{ id: "low", settings: { reasoningEffort: "low" } }],
    },
  })

  const after = readJson(file(root, "index.json"))
  assert.deepEqual(after.providers, [...before.providers, "example-prov"].sort())
  assert.notEqual(after.revision, before.revision)
  const validate = cli(["validate"], root)
  assert.equal(validate.status, 0, validate.stderr)
})

test("重复 add-provider id / 重复 add-model key → 退出码 1 且文件不变", () => {
  const root = freshRoot()
  const indexBefore = readFileSync(file(root, "index.json"), "utf8")
  const dup = cli(["add-provider", "--id", ANCHOR_ID, "--name", "X", "--model", "m", "--context", "1", "--output", "1"], root)
  assert.equal(dup.status, 1)
  assert.match(dup.stderr, /已存在/)
  assert.equal(readFileSync(file(root, "index.json"), "utf8"), indexBefore)

  const modelsPath = file(root, "providers", ANCHOR_ID, "models.json")
  const modelsBefore = readFileSync(modelsPath, "utf8")
  const conflict = cli(
    ["add-model", "--provider", ANCHOR_ID, "--key", ANCHOR_INLINE, "--context", "1", "--output", "1"],
    root,
  )
  assert.equal(conflict.status, 1)
  assert.match(conflict.stderr, /已存在模型/)
  assert.equal(readFileSync(modelsPath, "utf8"), modelsBefore)
})

test("add-model --base 引用共享模型：只写 base，不用重复 limit", () => {
  const root = freshRoot()
  const result = cli(["add-model", "--provider", ANCHOR_ID, "--key", "flash", "--base", ANCHOR_BASE], root)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readJson(file(root, "providers", ANCHOR_ID, "models.json")).flash, {
    base: ANCHOR_BASE,
  })
  assert.equal(cli(["validate"], root).status, 0)
})

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

test("add-shared-model --lab/--key 写 models/<lab>/<key>.json；重复冲突", () => {
  const root = freshRoot()
  const added = cli(
    ["add-shared-model", "--lab", "solo", "--key", "foo", "--model-name", "Foo", "--context", "1000", "--output", "100"],
    root,
  )
  assert.equal(added.status, 0, added.stderr)
  assert.deepEqual(readJson(file(root, "models", "solo", "foo.json")), {
    name: "Foo",
    limit: { context: 1000, output: 100 },
  })

  const conflict = cli(["add-shared-model", "--lab", "solo", "--key", "foo", "--context", "1", "--output", "1"], root)
  assert.equal(conflict.status, 1)
  assert.match(conflict.stderr, /已存在/)
})

test("add-provider baseURL 占用 → 报错；--force 放行（评审 C）", () => {
  const root = freshRoot()
  const args = ["add-provider", "--id", "dup-url", "--name", "Dup", "--baseurl", ANCHOR_URL, "--model", "m", "--inline", "--context", "1", "--output", "1"]
  const conflicted = cli(args, root)
  assert.equal(conflicted.status, 1)
  assert.match(conflicted.stderr, new RegExp(`已被供应商 "${escapeRe(ANCHOR_ID)}" 使用`))

  const forced = cli([...args, "--force"], root)
  assert.equal(forced.status, 0, forced.stderr)
  assert.ok(existsSync(file(root, "providers", "dup-url", "provider.json")))
})

test("RF5：非法路径段（含 : 或 /）被拒", () => {
  const root = freshRoot()
  const badId = cli(["add-provider", "--id", "a:b", "--name", "Bad", "--model", "m", "--context", "1", "--output", "1"], root)
  assert.equal(badId.status, 1)
  assert.match(badId.stderr, /非法/)

  const badBase = cli(["add-model", "--provider", ANCHOR_ID, "--key", "m", "--base", "a:b/c"], root)
  assert.equal(badBase.status, 1)
  assert.match(badBase.stderr, /非法/)

  const badLab = cli(["add-shared-model", "--lab", "a:b", "--key", "m", "--context", "1", "--output", "1"], root)
  assert.equal(badLab.status, 1)
  assert.match(badLab.stderr, /非法/)
})

test("sync：手改子文件后同步 revision；不 sync 则 validate 报 revision 不一致", () => {
  const root = freshRoot()
  assert.equal(cli(["sync"], root).status, 0)
  const modelsPath = file(root, "providers", ANCHOR_ID, "models.json")
  const models = readJson(modelsPath)
  models["anchor-extra"] = { limit: { context: 1000, output: 100 } }
  writeFileSync(modelsPath, `${JSON.stringify(models, null, 2)}\n`)

  const stale = cli(["validate"], root)
  assert.equal(stale.status, 1)
  assert.match(stale.stderr, /revision 不一致/)

  const synced = cli(["sync"], root)
  assert.equal(synced.status, 0, synced.stderr)
  assert.equal(cli(["validate"], root).status, 0)
})

test("格式化幂等：sync 两次文件字节不变", () => {
  const root = freshRoot()
  assert.equal(cli(["sync"], root).status, 0)
  const before = snapshot(root)
  assert.equal(cli(["sync"], root).status, 0)
  assert.deepEqual(snapshot(root), before)
})

test("CLI 健壮性：--base-url 是 --baseurl 的别名；未知参数必须报错而不是静默忽略", () => {
  const root = freshRoot()
  const aliased = cli(
    [
      "add-provider",
      "--id", "aliasprov", "--name", "Alias", "--base-url", "https://api.alias.example/v1",
      "--model", "m", "--inline", "--context", "1", "--output", "1",
    ],
    root,
  )
  assert.equal(aliased.status, 0, aliased.stderr)
  assert.equal(readJson(file(root, "providers", "aliasprov", "provider.json")).baseURL, "https://api.alias.example/v1")

  const unknown = cli(
    [
      "add-provider",
      "--id", "x", "--name", "X", "--baseurl", "https://api.x.example/v1",
      "--model", "m", "--context", "1", "--output", "1", "--keylabl", "oops",
    ],
    root,
  )
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /未知参数 --keylabl/)
  // 未产出半成品
  assert.equal(existsSync(file(root, "providers", "x", "provider.json")), false)
})

test("validate 汇总计数；子文件损坏报错", () => {
  const root = freshRoot()
  cli(["sync"], root)
  const ok = cli(["validate"], root)
  assert.equal(ok.status, 0, ok.stderr)
  const counts = registryCounts(root)
  assert.match(
    ok.stdout,
    new RegExp(`供应商=${counts.providers} · 模型=${counts.models} · 顶层共享模型=${counts.shared}`),
  )

  const broken = freshRoot()
  writeFileSync(file(broken, "providers", ANCHOR_ID, "models.json"), "{ broken")
  const bad = cli(["validate"], broken)
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /校验失败/)
})

test("B1：同一内容 CRLF 与 LF 的 revision 相同（换行归一）", () => {
  const rel = ["providers", ANCHOR_ID, "models.json"]
  const lfRoot = freshRoot()
  const crlfRoot = freshRoot()
  const lf = readFileSync(file(lfRoot, ...rel), "utf8").replace(/\r\n/g, "\n")
  writeFileSync(file(lfRoot, ...rel), lf)
  writeFileSync(file(crlfRoot, ...rel), lf.replace(/\n/g, "\r\n"))

  assert.equal(cli(["sync"], lfRoot).status, 0)
  assert.equal(cli(["sync"], crlfRoot).status, 0)
  assert.equal(readJson(file(crlfRoot, "index.json")).revision, readJson(file(lfRoot, "index.json")).revision)
  // 且两边都能通过校验（跨平台一致）
  assert.equal(cli(["validate"], crlfRoot).status, 0)
  assert.equal(cli(["validate"], lfRoot).status, 0)
})

test("I1：单段字段不许含 /；--base 恰好两段", () => {
  const root = freshRoot()
  const badId = cli(["add-provider", "--id", "a/b", "--name", "X", "--model", "m", "--context", "1", "--output", "1"], root)
  assert.equal(badId.status, 1)
  assert.match(badId.stderr, /非法/)

  const badLab = cli(["add-shared-model", "--lab", "a/b", "--key", "m", "--context", "1", "--output", "1"], root)
  assert.equal(badLab.status, 1)
  assert.match(badLab.stderr, /非法/)

  const badBase = cli(["add-model", "--provider", ANCHOR_ID, "--key", "m", "--base", "a/b/c"], root)
  assert.equal(badBase.status, 1)
  assert.match(badBase.stderr, /非法/)

  // 未产出坏树
  assert.equal(cli(["validate"], root).status, 0)
})

test("I2：add-provider 未给 --model-name 时不把供应商名当模型名", () => {
  const root = freshRoot()
  const result = cli(
    ["add-provider", "--id", "newprov", "--name", "New Provider", "--model", "m", "--inline", "--context", "1", "--output", "1"],
    root,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal("name" in readJson(file(root, "providers", "newprov", "models.json")).m, false)
})

test("能力多选：--input 写 input 模态", () => {
  const root = freshRoot()
  const result = cli(
    [
      "add-provider",
      "--id", "vision", "--name", "Vision", "--model", "v1", "--inline",
      "--context", "1000", "--output", "100",
      "--input", "text,image",
    ],
    root,
  )
  assert.equal(result.status, 0, result.stderr)
  const spec = readJson(file(root, "providers", "vision", "models.json")).v1
  assert.deepEqual(spec.input, ["text", "image"])
  assert.equal("tools" in spec, false, "tools 不属于最小配置，不应写入")
  assert.equal(cli(["validate"], root).status, 0)
})

test("list/search 暴露顶层共享模型（含未被引用的）；show 支持 <lab>/<model>", () => {
  const root = freshRoot()
  assert.equal(
    cli(["add-shared-model", "--lab", "solo", "--key", "only", "--model-name", "Solo", "--context", "1000", "--output", "100"], root).status,
    0,
  )

  const view = registryView(root)
  const list = cli(["list"], root)
  assert.equal(list.status, 0, list.stderr)
  // 原有共享模型 + 新加的 solo/only
  assert.match(list.stdout, new RegExp(`顶层共享模型（${view.sharedCount()}）`))
  assert.match(list.stdout, /solo\/only/)
  assert.match(list.stdout, new RegExp(escapeRe(ANCHOR_BASE)))

  const json = JSON.parse(cli(["list", "--json"], root).stdout)
  const shared = json.sharedModels as Array<{ ref: string; usedBy: string[] }>
  assert.ok(shared.some((m) => m.ref === "solo/only" && m.usedBy.length === 0), "未被引用的共享模型也要列出")
  assert.ok(
    shared.some((m) => m.ref === ANCHOR_BASE && m.usedBy.includes(ANCHOR_ID)),
    "被引用的共享模型要带出引用方",
  )

  const search = cli(["search", "solo"], root) // 未被引用也能搜到
  assert.equal(search.status, 0, search.stderr)
  assert.match(search.stdout, /solo\/only/)

  const show = cli(["show", ANCHOR_BASE], root)
  assert.equal(show.status, 0, show.stderr)
  assert.match(show.stdout, new RegExp(`"context": ${ANCHOR_BASE_LIMIT.context}`))
})

test("check：无孤儿时全绿；孤儿共享模型=提醒、--strict 失败；悬空引用=错误", () => {
  const root = freshRoot()
  // 随仓可能带孤儿共享模型（先建共享模型、后被引用的中间态），先删掉无人引用的再断言「全绿」——
  // 断言的是 CLI 的判定逻辑，不是随仓当前数据长什么样。
  const referenced = new Set<string>()
  for (const id of registryView(root).ids()) {
    for (const spec of Object.values(registryView(root).models(id))) {
      if (typeof spec.base === "string") referenced.add(spec.base)
    }
  }
  for (const ref of registryView(root).sharedRefs()) {
    if (referenced.has(ref)) continue
    assert.equal(
      cli(["remove-shared-model", "--ref", ref], root).status,
      0,
      "未被引用的共享模型应当能直接删掉",
    )
  }

  const clean = cli(["check"], root)
  assert.equal(clean.status, 0, clean.stderr)
  assert.equal(cli(["check", "--strict"], root).status, 0, clean.stderr)

  assert.equal(cli(["add-shared-model", "--lab", "solo", "--key", "only", "--context", "1", "--output", "1"], root).status, 0)
  const warn = cli(["check"], root)
  assert.equal(warn.status, 0, warn.stderr)
  assert.match(warn.stdout, /未被引用的共享模型 "solo\/only"/)
  const strict = cli(["check", "--strict"], root)
  assert.equal(strict.status, 1)
  assert.match(strict.stderr, /--strict/)

  const modelsPath = file(root, "providers", ANCHOR_ID, "models.json")
  const models = readJson(modelsPath)
  models[ANCHOR_BASE_ONLY].base = "ghost/none"
  writeFileSync(modelsPath, `${JSON.stringify(models, null, 2)}\n`)
  const bad = cli(["check"], root)
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /悬空引用/)
})

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

test("set-model：字段补丁 + --unset 清空；非法 --unset 报错", () => {
  const root = freshRoot()
  const set = cli(
    ["set-model", "--provider", ANCHOR_ID, "--key", ANCHOR_BASE_ONLY, "--model-name", "DS", "--unset", "base", "--context", "1000", "--output", "100"],
    root,
  )
  assert.equal(set.status, 0, set.stderr)
  assert.deepEqual(readJson(file(root, "providers", ANCHOR_ID, "models.json"))[ANCHOR_BASE_ONLY], {
    name: "DS",
    limit: { context: 1000, output: 100 },
  })

  const bad = cli(["set-model", "--provider", ANCHOR_ID, "--key", ANCHOR_BASE_ONLY, "--unset", "nope"], root)
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /--unset nope 不支持/)
})

test("set-provider：改名 / --unset baseurl（未传字段保持原样）", () => {
  const root = freshRoot()
  const anchorPackage = registryView(root).provider(ANCHOR_ID).package
  const set = cli(["set-provider", "--id", ANCHOR_ID, "--name", "Anchor Renamed", "--unset", "baseurl"], root)
  assert.equal(set.status, 0, set.stderr)
  const provider = readJson(file(root, "providers", ANCHOR_ID, "provider.json"))
  assert.equal(provider.name, "Anchor Renamed")
  assert.equal(provider.package, anchorPackage, "未传的 package 保持原样")
  assert.equal("baseURL" in provider, false)
})

test("set-shared-model：补丁只改传入字段，并提示引用方", () => {
  const root = freshRoot()
  const anchorName = registryView(root).sharedSpec(ANCHOR_BASE).name
  const set = cli(["set-shared-model", "--lab", "anchor", "--key", "base-model", "--context", "123", "--output", "45"], root)
  assert.equal(set.status, 0, set.stderr)
  assert.match(set.stdout, /改动对引用它的供应商同时生效/)
  const model = readJson(file(root, "models", "anchor", "base-model.json"))
  assert.deepEqual(model.limit, { context: 123, output: 45 })
  assert.equal(model.name, anchorName, "未传的 name 保持原样")
})

test("remove-model：拒绝删唯一模型；可删多模型之一", () => {
  const root = freshRoot()
  // 锚点供应商自带 3 个模型，逐个删到只剩一个，最后一个必须被拒
  const modelsPath = file(root, "providers", ANCHOR_ID, "models.json")
  assert.ok(Object.keys(readJson(modelsPath)).length > 1)

  const dropped = cli(["remove-model", "--provider", ANCHOR_ID, "--key", ANCHOR_OVERRIDE], root)
  assert.equal(dropped.status, 0, dropped.stderr)
  assert.equal(ANCHOR_OVERRIDE in readJson(modelsPath), false)

  const last = cli(["remove-model", "--provider", ANCHOR_ID, "--key", ANCHOR_INLINE], root)
  assert.equal(last.status, 0, last.stderr)
  const refuse = cli(["remove-model", "--provider", ANCHOR_ID, "--key", ANCHOR_BASE_ONLY], root)
  assert.equal(refuse.status, 1, "删到只剩一个时，删最后一个必须被拒")
  assert.match(refuse.stderr, /唯一的模型/)
  assert.deepEqual(Object.keys(readJson(modelsPath)), [ANCHOR_BASE_ONLY])
})

test("remove-provider：删目录 + 从 index 移除；拒绝删唯一供应商", () => {
  const root = freshRoot()
  const view = registryView(root)
  const before = view.ids()
  const doomed = need(before[0], "至少一家供应商")

  const removed = cli(["remove-provider", "--id", doomed], root)
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(existsSync(file(root, "providers", doomed)), false)
  assert.deepEqual(readJson(file(root, "index.json")).providers, before.filter((id) => id !== doomed))
  assert.equal(cli(["validate"], root).status, 0)

  // 一路删到只剩最后一家
  for (const id of registryView(root).ids()) {
    const result = cli(["remove-provider", "--id", id], root)
    if (id === registryView(root).ids().at(-1)) {
      assert.equal(result.status, 1, "删唯一供应商必须被拒")
      assert.match(result.stderr, /唯一的供应商/)
    } else {
      assert.equal(result.status, 0, result.stderr)
    }
  }
})

test("remove-shared-model：仍被引用则拒绝；无人引用才删并清理空 lab 目录", () => {
  const root = freshRoot()
  const refused = cli(["remove-shared-model", "--ref", ANCHOR_BASE], root)
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /仍被引用/)
  // 提示应**推荐** remove-model，而不是把危险的 `--unset base` 排在前面（纯 base 引用会变无 limit 的非法模型）
  assert.match(refused.stderr, /推荐用 remove-model/)
  assert.match(refused.stderr, /无 limit 的非法模型/)

  assert.equal(cli(["add-shared-model", "--lab", "solo", "--key", "only", "--context", "1", "--output", "1"], root).status, 0)
  const removed = cli(["remove-shared-model", "--ref", "solo/only"], root)
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(existsSync(file(root, "models", "solo")), false)
})

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

test("软提示：内联参数与某共享模型相同 → 提示可用 --base 复用", () => {
  const root = freshRoot()
  const result = cli(
    [
      "add-model", "--provider", ANCHOR_ID, "--key", "anchor-copy", "--inline",
      "--model-name", "Anchor Base", "--context", String(ANCHOR_BASE_LIMIT.context),
      "--output", String(ANCHOR_BASE_LIMIT.output),
    ],
    root,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`可改用 --base ${escapeRe(ANCHOR_BASE)} 复用`))
})

test("复用共享模型：add-provider --base 只写 base/modelID（不重复 limit）", () => {
  const root = freshRoot()
  const result = cli(
    [
      "add-provider", "--id", "reuse", "--name", "Reuse", "--baseurl", "https://api.reuse.example/v1",
      "--model", "reuse-model", "--base", ANCHOR_BASE,
      "--model-id", "upstream/reuse",
    ],
    root,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readJson(file(root, "providers", "reuse", "models.json")), {
    "reuse-model": { base: ANCHOR_BASE, modelID: "upstream/reuse" },
  })
  assert.equal(cli(["validate"], root).status, 0)
})

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
  assert.deepEqual(readJson(file(root, "models", lab, "glm-5.json")), {
    name: "GLM-5",
    limit: { context: 200000, output: 32000 },
  })
})

test("add-provider --base 复用已有 canon（只写 base/modelID）", () => {
  const root = freshRoot()
  const result = cli(
    ["add-provider", "--id", "reuse2", "--name", "Reuse2", "--baseurl", "https://api.reuse2.test/v1",
     "--model", "m", "--base", ANCHOR_BASE, "--model-id", "up/m"],
    root,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readJson(file(root, "providers", "reuse2", "models.json")), {
    m: { base: ANCHOR_BASE, modelID: "up/m" },
  })
})