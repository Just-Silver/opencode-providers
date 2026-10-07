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
      "--id", "open-design",
      "--name", "Open Design",
      "--baseurl", "https://api.open-design.ai/v1",
      "--protocol", "chat",
      "--model", "open-design-chat",
      "--model-name", "Open Design Chat",
      "--model-id", "open-design-chat-v1",
      "--context", "131072",
      "--output", "32768",
      "--variant", 'low:{"reasoningEffort":"low"}',
    ],
    root,
  )
  assert.equal(result.status, 0, result.stderr)

  assert.deepEqual(readJson(file(root, "providers", "open-design", "provider.json")), {
    name: "Open Design",
    package: "@opencode/ai/providers/openai-compatible",
    baseURL: "https://api.open-design.ai/v1",
  })
  assert.deepEqual(readJson(file(root, "providers", "open-design", "models.json")), {
    "open-design-chat": {
      name: "Open Design Chat",
      modelID: "open-design-chat-v1",
      limit: { context: 131072, output: 32768 },
      variants: [{ id: "low", settings: { reasoningEffort: "low" } }],
    },
  })

  const after = readJson(file(root, "index.json"))
  assert.deepEqual(after.providers, ["command-code", "open-design", "r4-coder"])
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
  assert.match(ok.stdout, /供应商=2 · 模型=2 · 顶层共享模型=1/)

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