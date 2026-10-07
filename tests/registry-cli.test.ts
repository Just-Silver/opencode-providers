import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(
  new URL("../.opencode/skills/opencode-providers-registry/scripts/registry.mjs", import.meta.url),
)
const SHIPPED_ROOT = fileURLToPath(new URL("../registry", import.meta.url))

/** 每次复制一份随仓 registry 目录树，写坏也不污染仓库。 */
function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-registry-"))
  const root = join(dir, "registry")
  cpSync(SHIPPED_ROOT, root, { recursive: true })
  return root
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
  const providerIds = readdirSync(file(root, "providers"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  const models = providerIds.reduce(
    (total, id) => total + Object.keys(readJson(file(root, "providers", id, "models.json"))).length,
    0,
  )
  const shared = walk(file(root, "models")).filter((rel) => rel.endsWith(".json")).length
  return { providers: providerIds.length, models, shared }
}

test("list 打印供应商与模型，不吐整份 JSON", () => {
  const root = freshRoot()
  const result = cli(["list"], root)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /command-code \(Command Code\)/)
  assert.match(result.stdout, /r4-coder \(R4 Coder\)/)
  assert.match(result.stdout, /- deepseek-v4\.1-flash\s+→ deepseek\/deepseek-v4\.1-flash/)
})

test("search 命中供应商名/模型 key；未命中退出码 1", () => {
  const root = freshRoot()
  const hit = cli(["search", "R4"], root)
  assert.equal(hit.status, 0, hit.stderr)
  assert.match(hit.stdout, /r4-coder/)
  assert.doesNotMatch(hit.stdout, /command-code/)

  const miss = cli(["search", "does-not-exist"], root)
  assert.equal(miss.status, 1)
  assert.match(miss.stdout, /没有匹配/)
})

test("show 单看一个供应商/模型；不存在报错", () => {
  const root = freshRoot()
  const provider = cli(["show", "r4-coder"], root)
  assert.equal(provider.status, 0, provider.stderr)
  assert.match(provider.stdout, /"models"/)
  assert.doesNotMatch(provider.stdout, /command-code/)

  const model = cli(["show", "command-code", "deepseek-v4.1-flash"], root)
  assert.equal(model.status, 0, model.stderr)
  assert.match(model.stdout, /"modelID": "deepseek\/deepseek-v4\.1-flash"/)

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
  const dup = cli(["add-provider", "--id", "r4-coder", "--name", "X", "--model", "m", "--context", "1", "--output", "1"], root)
  assert.equal(dup.status, 1)
  assert.match(dup.stderr, /已存在/)
  assert.equal(readFileSync(file(root, "index.json"), "utf8"), indexBefore)

  const modelsPath = file(root, "providers", "r4-coder", "models.json")
  const modelsBefore = readFileSync(modelsPath, "utf8")
  const conflict = cli(
    ["add-model", "--provider", "r4-coder", "--key", "deepseek-v4.1-flash", "--context", "1", "--output", "1"],
    root,
  )
  assert.equal(conflict.status, 1)
  assert.match(conflict.stderr, /已存在模型/)
  assert.equal(readFileSync(modelsPath, "utf8"), modelsBefore)
})

test("add-model --base 引用共享模型：只写 base，不用重复 limit", () => {
  const root = freshRoot()
  const result = cli(["add-model", "--provider", "command-code", "--key", "flash", "--base", "deepseek/deepseek-v4.1-flash"], root)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readJson(file(root, "providers", "command-code", "models.json")).flash, {
    base: "deepseek/deepseek-v4.1-flash",
  })
  assert.equal(cli(["validate"], root).status, 0)
})

test("add-shared-model --lab/--key 写 models/<lab>/<key>.json；重复冲突", () => {
  const root = freshRoot()
  const added = cli(
    ["add-shared-model", "--lab", "deepseek", "--key", "foo", "--model-name", "Foo", "--context", "1000", "--output", "100"],
    root,
  )
  assert.equal(added.status, 0, added.stderr)
  assert.deepEqual(readJson(file(root, "models", "deepseek", "foo.json")), {
    name: "Foo",
    limit: { context: 1000, output: 100 },
  })

  const conflict = cli(["add-shared-model", "--lab", "deepseek", "--key", "foo", "--context", "1", "--output", "1"], root)
  assert.equal(conflict.status, 1)
  assert.match(conflict.stderr, /已存在/)
})

test("add-provider baseURL 占用 → 报错；--force 放行（评审 C）", () => {
  const root = freshRoot()
  const args = ["add-provider", "--id", "dup-url", "--name", "Dup", "--baseurl", "https://api.r4.codes/v1", "--model", "m", "--context", "1", "--output", "1"]
  const conflicted = cli(args, root)
  assert.equal(conflicted.status, 1)
  assert.match(conflicted.stderr, /已被供应商 "r4-coder" 使用/)

  const forced = cli([...args, "--force"], root)
  assert.equal(forced.status, 0, forced.stderr)
  assert.ok(existsSync(file(root, "providers", "dup-url", "provider.json")))
})

test("RF5：非法路径段（含 : 或 /）被拒", () => {
  const root = freshRoot()
  const badId = cli(["add-provider", "--id", "a:b", "--name", "Bad", "--model", "m", "--context", "1", "--output", "1"], root)
  assert.equal(badId.status, 1)
  assert.match(badId.stderr, /非法/)

  const badBase = cli(["add-model", "--provider", "r4-coder", "--key", "m", "--base", "a:b/c"], root)
  assert.equal(badBase.status, 1)
  assert.match(badBase.stderr, /非法/)

  const badLab = cli(["add-shared-model", "--lab", "a:b", "--key", "m", "--context", "1", "--output", "1"], root)
  assert.equal(badLab.status, 1)
  assert.match(badLab.stderr, /非法/)
})

test("sync：手改子文件后同步 revision；不 sync 则 validate 报 revision 不一致", () => {
  const root = freshRoot()
  assert.equal(cli(["sync"], root).status, 0)
  const modelsPath = file(root, "providers", "r4-coder", "models.json")
  const models = readJson(modelsPath)
  models["r4-mini"] = { limit: { context: 1000, output: 100 } }
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
      "--model", "m", "--context", "1", "--output", "1",
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
  writeFileSync(file(broken, "providers", "r4-coder", "models.json"), "{ broken")
  const bad = cli(["validate"], broken)
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /校验失败/)
})

test("B1：同一内容 CRLF 与 LF 的 revision 相同（换行归一）", () => {
  const rel = ["providers", "r4-coder", "models.json"]
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

  const badBase = cli(["add-model", "--provider", "r4-coder", "--key", "m", "--base", "a/b/c"], root)
  assert.equal(badBase.status, 1)
  assert.match(badBase.stderr, /非法/)

  // 未产出坏树
  assert.equal(cli(["validate"], root).status, 0)
})

test("I2：add-provider 未给 --model-name 时不把供应商名当模型名", () => {
  const root = freshRoot()
  const result = cli(
    ["add-provider", "--id", "newprov", "--name", "New Provider", "--model", "m", "--context", "1", "--output", "1"],
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
      "--id", "vision", "--name", "Vision", "--model", "v1",
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

  const list = cli(["list"], root)
  assert.equal(list.status, 0, list.stderr)
  assert.match(list.stdout, /顶层共享模型（2）/)
  assert.match(list.stdout, /solo\/only/)
  assert.match(list.stdout, /deepseek\/deepseek-v4\.1-flash/)

  const json = JSON.parse(cli(["list", "--json"], root).stdout)
  const shared = json.sharedModels as Array<{ ref: string; usedBy: string[] }>
  assert.ok(shared.some((m) => m.ref === "solo/only" && m.usedBy.length === 0))
  assert.ok(shared.some((m) => m.ref === "deepseek/deepseek-v4.1-flash" && m.usedBy.includes("r4-coder")))

  const search = cli(["search", "solo"], root) // 未被引用也能搜到
  assert.equal(search.status, 0, search.stderr)
  assert.match(search.stdout, /solo\/only/)

  const show = cli(["show", "deepseek/deepseek-v4.1-flash"], root)
  assert.equal(show.status, 0, show.stderr)
  assert.match(show.stdout, /"context": 1048576/)
})

test("check：随仓通过；孤儿共享模型=提醒、--strict 失败；悬空引用=错误", () => {
  const root = freshRoot()
  assert.equal(cli(["check"], root).status, 0)
  assert.equal(cli(["check", "--strict"], root).status, 0)

  assert.equal(cli(["add-shared-model", "--lab", "solo", "--key", "only", "--context", "1", "--output", "1"], root).status, 0)
  const warn = cli(["check"], root)
  assert.equal(warn.status, 0, warn.stderr)
  assert.match(warn.stdout, /未被引用的共享模型 "solo\/only"/)
  const strict = cli(["check", "--strict"], root)
  assert.equal(strict.status, 1)
  assert.match(strict.stderr, /--strict/)

  const modelsPath = file(root, "providers", "r4-coder", "models.json")
  const models = readJson(modelsPath)
  models["deepseek-v4.1-flash"].base = "ghost/none"
  writeFileSync(modelsPath, `${JSON.stringify(models, null, 2)}\n`)
  const bad = cli(["check"], root)
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /悬空引用/)
})

test("set-model：字段补丁 + --unset 清空；非法 --unset 报错", () => {
  const root = freshRoot()
  const set = cli(
    ["set-model", "--provider", "r4-coder", "--key", "deepseek-v4.1-flash", "--model-name", "DS", "--unset", "base", "--context", "1000", "--output", "100"],
    root,
  )
  assert.equal(set.status, 0, set.stderr)
  assert.deepEqual(readJson(file(root, "providers", "r4-coder", "models.json"))["deepseek-v4.1-flash"], {
    name: "DS",
    limit: { context: 1000, output: 100 },
  })

  const bad = cli(["set-model", "--provider", "r4-coder", "--key", "deepseek-v4.1-flash", "--unset", "nope"], root)
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /--unset nope 不支持/)
})

test("set-provider：改名 / --unset baseurl（未传字段保持原样）", () => {
  const root = freshRoot()
  const set = cli(["set-provider", "--id", "r4-coder", "--name", "R4 Renamed", "--unset", "baseurl"], root)
  assert.equal(set.status, 0, set.stderr)
  const provider = readJson(file(root, "providers", "r4-coder", "provider.json"))
  assert.equal(provider.name, "R4 Renamed")
  assert.equal(provider.package, "@opencode/ai/providers/openai-compatible")
  assert.equal("baseURL" in provider, false)
})

test("set-shared-model：补丁只改传入字段，并提示引用方", () => {
  const root = freshRoot()
  const set = cli(["set-shared-model", "--lab", "deepseek", "--key", "deepseek-v4.1-flash", "--context", "123", "--output", "45"], root)
  assert.equal(set.status, 0, set.stderr)
  assert.match(set.stdout, /改动对引用它的供应商同时生效/)
  const model = readJson(file(root, "models", "deepseek", "deepseek-v4.1-flash.json"))
  assert.deepEqual(model.limit, { context: 123, output: 45 })
  assert.equal(model.name, "Deepseek V4.1 Flash")
})

test("remove-model：拒绝删唯一模型；可删多模型之一", () => {
  const root = freshRoot()
  const only = cli(["remove-model", "--provider", "r4-coder", "--key", "deepseek-v4.1-flash"], root)
  assert.equal(only.status, 1)
  assert.match(only.stderr, /唯一的模型/)

  assert.equal(cli(["add-model", "--provider", "r4-coder", "--key", "extra", "--context", "1", "--output", "1"], root).status, 0)
  const removed = cli(["remove-model", "--provider", "r4-coder", "--key", "extra"], root)
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal("extra" in readJson(file(root, "providers", "r4-coder", "models.json")), false)
})

test("remove-provider：删目录 + 从 index 移除；拒绝删唯一供应商", () => {
  const root = freshRoot()
  const removed = cli(["remove-provider", "--id", "r4-coder"], root)
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(existsSync(file(root, "providers", "r4-coder")), false)
  assert.deepEqual(readJson(file(root, "index.json")).providers, ["command-code", "open-design"])
  assert.equal(cli(["validate"], root).status, 0)

  assert.equal(cli(["remove-provider", "--id", "command-code"], root).status, 0)
  const last = cli(["remove-provider", "--id", "open-design"], root)
  assert.equal(last.status, 1)
  assert.match(last.stderr, /唯一的供应商/)
})

test("remove-shared-model：仍被引用则拒绝；无人引用才删并清理空 lab 目录", () => {
  const root = freshRoot()
  const refused = cli(["remove-shared-model", "--ref", "deepseek/deepseek-v4.1-flash"], root)
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /仍被引用/)

  assert.equal(cli(["add-shared-model", "--lab", "solo", "--key", "only", "--context", "1", "--output", "1"], root).status, 0)
  const removed = cli(["remove-shared-model", "--ref", "solo/only"], root)
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(existsSync(file(root, "models", "solo")), false)
})

test("软提示：内联参数与某共享模型相同 → 提示可用 --base 复用", () => {
  const root = freshRoot()
  const result = cli(
    [
      "add-model", "--provider", "r4-coder", "--key", "ds-copy",
      "--model-name", "Deepseek V4.1 Flash", "--context", "1048576", "--output", "393216",
      "--input", "text,image",
      "--variant", 'low:{"reasoningEffort":"low"}',
      "--variant", 'high:{"reasoningEffort":"high"}',
      "--variant", 'max:{"reasoningEffort":"max"}',
    ],
    root,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /可改用 --base deepseek\/deepseek-v4\.1-flash 复用/)
})

test("复用共享模型：add-provider --base 只写 base/modelID（不重复 limit）", () => {
  const root = freshRoot()
  const result = cli(
    [
      "add-provider", "--id", "reuse", "--name", "Reuse", "--baseurl", "https://api.reuse.example/v1",
      "--model", "deepseek-v4.1-flash", "--base", "deepseek/deepseek-v4.1-flash",
      "--model-id", "deepseek/deepseek-v4.1-flash",
    ],
    root,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readJson(file(root, "providers", "reuse", "models.json")), {
    "deepseek-v4.1-flash": { base: "deepseek/deepseek-v4.1-flash", modelID: "deepseek/deepseek-v4.1-flash" },
  })
  assert.equal(cli(["validate"], root).status, 0)
})