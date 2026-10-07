#!/usr/bin/env node
/**
 * 分文件注册表维护 CLI（opencode-providers）。
 *
 * 存在的意义：让 agent **永远不用读整份注册表**（它会随供应商/模型增长），
 * 只用下面的子命令读/写；写入前一律先组装 + `parseRegistry` 校验，冲突直接报错、不落盘。
 *
 * 注册表是一棵目录树：
 *   <root>/index.json                  # manifest（本 CLI 自动维护，人手不碰）
 *   <root>/providers/<id>/provider.json
 *   <root>/providers/<id>/models.json
 *   <root>/models/<lab>/<model>.json   # 顶层共享模型
 *
 *   node scripts/registry.mjs list [--json]
 *   node scripts/registry.mjs search <关键词> [--json]
 *   node scripts/registry.mjs show <供应商id> [模型key] [--json]
 *   node scripts/registry.mjs validate
 *   node scripts/registry.mjs sync
 *   node scripts/registry.mjs add-provider --id ID --name 名称 --baseurl URL [--protocol chat] \
 *        --model KEY [--model-name 名称] [--model-id 上游id] [--context N --output N] [--variant id] [--base lab/model] [--force]
 *   node scripts/registry.mjs add-model --provider ID --key KEY [--model-name 名称] [--model-id 上游id] \
 *        [--context N --output N] [--variant id[:settingsJSON]] [--base lab/model] [--input text,image,...]
 *   node scripts/registry.mjs add-shared-model --lab LAB --key KEY [--model-name 名称] [--context N --output N] [--variant id[:settingsJSON]] [--input text,image,...]
 *
 * 通用：`--root <注册表目录>` 覆盖默认位置；`--json` 输出机器可读结果。
 * 严格只写最小字段（供应商：name/package/baseURL；模型：name/modelID/limit/variants/base；能力：input），
 * 其余不写（keyLabel/settings/headers/cost/tools/output…）——注册表铁律由脚本强制。
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  SUPPORTED_SCHEMA_VERSION,
  parseRegistry,
  resolveModelSpec,
} from "../../../../plugin/opencode-providers/registry/schema.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, "../../../../registry")

/** 协议形态 → package（默认 chat）。 */
const PROTOCOL_PACKAGES = {
  chat: "@opencode/ai/providers/openai-compatible",
  responses: "@opencode/ai/providers/openai-compatible/responses",
  messages: "@opencode/ai/providers/anthropic-compatible",
}
const DEFAULT_PROTOCOL = "chat"

/** 单个路径段允许的字符（会拼进 `lab/model` 与文件名，禁 `/`、`\`、`:`、空白等）。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

class CliError extends Error {}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

// ── 参数解析 ────────────────────────────────────────────────────────────────

const BOOLEAN_FLAGS = new Set(["json", "force", "help"])

function parseArgs(argv) {
  const positional = []
  const flags = {}
  const add = (key, value) => {
    if (key in flags) flags[key] = [...(Array.isArray(flags[key]) ? flags[key] : [flags[key]]), value]
    else flags[key] = value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const eqForm = arg.indexOf("=")
    if (eqForm !== -1) {
      const rawKey = arg.slice(2, eqForm)
      add(rawKey === "base-url" ? "baseurl" : rawKey, arg.slice(eqForm + 1))
      continue
    }
    const rawKey = arg.slice(2)
    // `--base-url` 是常见写法，作为 `--baseurl` 的别名（拼错/未知参数一律报错，别静默忽略）。
    const key = rawKey === "base-url" ? "baseurl" : rawKey
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith("--")) {
      add(key, next)
      index += 1
    } else {
      add(key, true)
    }
  }
  return { positional, flags }
}

const lastOf = (flags, key) => {
  const value = flags[key]
  return Array.isArray(value) ? value[value.length - 1] : value
}
const allOf = (flags, key) => {
  const value = flags[key]
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function required(flags, key, label) {
  const value = lastOf(flags, key)
  if (typeof value !== "string" || value.trim() === "") throw new CliError(`缺少 ${label}（--${key}）`)
  return value
}

const COMMON_FLAGS = new Set(["json", "help", "root"])

/** 未知参数必须报错——静默忽略会让「拼错的 flag」变成「悄悄少写字段」。 */
function rejectUnknownFlags(command, flags, allowed) {
  const known = new Set([...COMMON_FLAGS, ...allowed])
  for (const key of Object.keys(flags)) {
    if (known.has(key)) continue
    throw new CliError(`未知参数 --${key}（命令 ${command}）。允许：--${[...allowed].join(" --")}（通用：--json --root）`)
  }
}

function checkId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new CliError(`${label} "${value}" 非法：只允许字母/数字/._- ，不能以符号开头，段内不能含 / \\ : * ? " < > | 或空格`)
  }
  return value
}

/** `base` 引用：必须恰好两段 `lab/model`，每段过 ID_PATTERN。 */
function checkBaseRef(value) {
  const text = String(value)
  const segments = text.split("/")
  if (segments.length !== 2) throw new CliError(`--base "${text}" 非法：必须恰好是 <lab>/<model> 两段`)
  for (const segment of segments) checkId(segment, "--base")
  return text
}

function parsePositiveInt(value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) throw new CliError(`${label} 必须是正整数，收到 ${JSON.stringify(value)}`)
  return number
}

// ── 路径与文件 ──────────────────────────────────────────────────────────────

function resolveRoot(flags) {
  const override = lastOf(flags, "root")
  if (typeof override === "string" && override.trim() !== "") return resolve(process.cwd(), override)
  return DEFAULT_ROOT
}

const providerDir = (root, id) => join(root, "providers", id)
const sharedModelPath = (root, ref) => join(root, "models", ...ref.split("/")) + ".json"

function readJsonFile(path) {
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    throw new CliError(`读不到 ${path}：${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new CliError(`${path} 不是合法 JSON：${error.message}`)
  }
}

/** 固定排版写盘；内容未变则不动文件（幂等，避免无谓改动随仓文件）。 */
function writeJsonFile(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (existsSync(path) && readFileSync(path, "utf8") === text) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** 目录下所有文件（含子目录）的 posix 相对路径，前缀 `prefix`。 */
function listFiles(absDir, prefix) {
  if (!existsSync(absDir)) return []
  const out = []
  const visit = (relative) => {
    const dir = relative ? join(absDir, relative) : absDir
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(rel)
      else if (entry.isFile()) out.push(`${prefix}${rel}`)
    }
  }
  visit("")
  return out
}

function providerDirs(root) {
  const dir = join(root, "providers")
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/** `revision` = providers/** 与 models/** 全部文件按相对路径排序后的确定性哈希。 */
function computeRevision(root) {
  const files = [...listFiles(join(root, "providers"), "providers/"), ...listFiles(join(root, "models"), "models/")].sort()
  const hash = createHash("sha256")
  for (const rel of files) {
    hash.update(rel)
    hash.update("\0")
    // 归一换行：CRLF 与 LF 必须哈希一致，否则 Windows 检出（core.autocrlf）会算出与 CI（LF）不同的 revision。
    hash.update(readFileSync(join(root, ...rel.split("/")), "utf8").replace(/\r\n/g, "\n"))
    hash.update("\0")
  }
  return `sha256:${hash.digest("hex")}`
}

function readManifest(root) {
  const path = join(root, "index.json")
  let data
  try {
    data = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new CliError(`读不到/解析不了 ${path}：${error.message}`)
  }
  if (!isPlainObject(data)) throw new CliError(`${path} 必须是 JSON 对象`)
  if (data.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new CliError(`${path} schemaVersion 不支持：${JSON.stringify(data.schemaVersion)}`)
  }
  if (typeof data.revision !== "string" || !data.revision) throw new CliError(`${path} 缺少 revision`)
  if (!Array.isArray(data.providers) || !data.providers.every((id) => typeof id === "string" && id)) {
    throw new CliError(`${path} 的 providers 必须是字符串数组`)
  }
  return data
}

/** 重算 revision 并重写 index.json（providers 排序）。 */
function syncManifest(root) {
  const providers = providerDirs(root)
  const revision = computeRevision(root)
  writeJsonFile(join(root, "index.json"), { schemaVersion: SUPPORTED_SCHEMA_VERSION, revision, providers })
  return { providers, revision }
}

/** 把整棵树读进内存（用于校验与只读命令）。 */
function loadTree(root) {
  const manifest = readManifest(root)
  const providers = manifest.providers.map((id) => ({
    id,
    provider: readJsonFile(join(providerDir(root, id), "provider.json")),
    models: readJsonFile(join(providerDir(root, id), "models.json")),
  }))
  const shared = new Map()
  for (const rel of listFiles(join(root, "models"), "models/")) {
    shared.set(rel.slice("models/".length, -".json".length), readJsonFile(join(root, ...rel.split("/"))))
  }
  return { manifest, providers, shared }
}

function assemble(tree) {
  const models = {}
  for (const [ref, model] of tree.shared) models[ref] = model
  const providers = {}
  for (const entry of tree.providers) providers[entry.id] = { ...entry.provider, models: entry.models }
  return { schemaVersion: SUPPORTED_SCHEMA_VERSION, models, providers }
}

/** 组装 + 校验；失败抛 CliError（写命令在落盘前调用它）。 */
function parseTree(tree) {
  const result = parseRegistry(assemble(tree))
  if (!result.ok) throw new CliError(`注册表未通过 schema 校验：\n- ${result.errors.join("\n- ")}`)
  return result.registry
}

function requireShared(tree, base) {
  checkBaseRef(base)
  if (!tree.shared.has(base)) {
    throw new CliError(`--base "${base}" 不在共享模型里（现有：${[...tree.shared.keys()].join(", ") || "无"}）`)
  }
  return base
}

// ── 构造模型 ────────────────────────────────────────────────────────────────

function parseVariants(rawVariants) {
  if (rawVariants.length === 0) return undefined
  return rawVariants.map((raw) => {
    const colon = raw.indexOf(":")
    const id = colon === -1 ? raw : raw.slice(0, colon)
    if (!id) throw new CliError(`--variant 的 id 不能为空：${JSON.stringify(raw)}`)
    if (colon === -1) return { id }
    let settings
    try {
      settings = JSON.parse(raw.slice(colon + 1))
    } catch (error) {
      throw new CliError(`--variant ${id} 的 settings 不是合法 JSON：${error.message}`)
    }
    if (!isPlainObject(settings)) throw new CliError(`--variant ${id} 的 settings 必须是 JSON 对象`)
    return { id, settings }
  })
}

/** 由命令行 flags 构造一个最小字段的模型 spec（供应商内联 or 顶层共享）。 */
function buildModelSpec(flags, { key, allowBase }) {
  const spec = {}
  const base = lastOf(flags, "base")
  if (base !== undefined) {
    if (!allowBase) throw new CliError(`--base 只能用于供应商模型（共享模型不能再引用 base）`)
    spec.base = base
  }

  const name = lastOf(flags, "model-name")
  if (typeof name === "string" && name.trim() !== "") spec.name = name

  const modelId = lastOf(flags, "model-id")
  if (typeof modelId === "string" && modelId.trim() !== "" && modelId !== key) spec.modelID = modelId

  const context = lastOf(flags, "context")
  const output = lastOf(flags, "output")
  if (context !== undefined || output !== undefined) {
    if (context === undefined || output === undefined) {
      throw new CliError(`limit 要写就写全：--context 与 --output 必须同时给（模型 ${key}）`)
    }
    spec.limit = {
      context: parsePositiveInt(context, "--context"),
      output: parsePositiveInt(output, "--output"),
    }
  } else if (base === undefined) {
    throw new CliError(`模型 ${key} 既没有 --base 也没有 --context/--output：limit.context 与 limit.output 必须齐全，不许猜`)
  }

  const variants = parseVariants(allOf(flags, "variant"))
  if (variants) spec.variants = variants

  // 输入模态（可选，由技能多选问出来后显式写入）。不写 = 插件按宿主默认推断；tools 同理默认 true。
  const input = lastOf(flags, "input")
  if (typeof input === "string" && input.trim() !== "") {
    const values = input
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "")
    if (values.length === 0) throw new CliError(`--input 不能为空`)
    for (const value of values) checkId(value, "--input 模态")
    spec.input = values
  }

  return spec
}

function resolvePackage(flags) {
  const raw = lastOf(flags, "package")
  if (typeof raw === "string" && raw.trim() !== "") return raw
  const protocol = lastOf(flags, "protocol") ?? DEFAULT_PROTOCOL
  const mapped = PROTOCOL_PACKAGES[protocol]
  if (!mapped) throw new CliError(`--protocol 只支持 ${Object.keys(PROTOCOL_PACKAGES).join(" / ")}，收到 ${JSON.stringify(protocol)}`)
  return mapped
}

// ── 只读命令 ────────────────────────────────────────────────────────────────

function summarize(registry) {
  return Object.entries(registry.providers).map(([id, provider]) => ({
    id,
    name: provider.name,
    package: provider.package,
    baseURL: provider.baseURL,
    models: Object.entries(provider.models ?? {}).map(([key, spec]) => {
      const resolved = resolveModelSpec(registry, spec)
      return {
        key,
        modelID: spec.modelID ?? key,
        base: spec.base,
        name: spec.name ?? resolved?.name,
        limit: spec.limit ?? resolved?.limit,
        variants: (spec.variants ?? resolved?.variants ?? []).map((variant) => variant.id),
      }
    }),
  }))
}

function printList(rows, json) {
  if (json) {
    console.log(JSON.stringify({ providers: rows }, null, 2))
    return
  }
  if (rows.length === 0) {
    console.log("（注册表里没有供应商）")
    return
  }
  console.log(`${rows.length} 个供应商：\n`)
  for (const row of rows) {
    console.log(`${row.id} (${row.name}) · ${row.package} · ${row.baseURL ?? "(无 baseURL)"} · ${row.models.length} 个模型`)
    for (const model of row.models) {
      const parts = [`→ ${model.modelID}`]
      if (model.limit) parts.push(`ctx=${model.limit.context} out=${model.limit.output}`)
      if (model.variants.length) parts.push(`variants=${model.variants.join(",")}`)
      if (model.base) parts.push(`base=${model.base}`)
      console.log(`  - ${model.key}  ${parts.join("  ")}`)
    }
    console.log("")
  }
}

function matchesModel(model, query) {
  return [model.key, model.modelID, model.name]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().includes(query))
}

function commandList(flags) {
  rejectUnknownFlags("list", flags, new Set())
  const registry = parseTree(loadTree(resolveRoot(flags)))
  printList(summarize(registry), flags.json === true)
}

function commandSearch(positional, flags) {
  rejectUnknownFlags("search", flags, new Set(["query"]))
  const query = (positional[0] ?? lastOf(flags, "query") ?? "").toLowerCase()
  if (!query) throw new CliError("用法：search <关键词>")
  const all = summarize(parseTree(loadTree(resolveRoot(flags))))
  const rows = []
  for (const row of all) {
    const providerHit = row.id.toLowerCase().includes(query) || String(row.name).toLowerCase().includes(query)
    const models = providerHit ? row.models : row.models.filter((model) => matchesModel(model, query))
    if (providerHit || models.length > 0) rows.push({ ...row, models })
  }
  if (rows.length === 0) {
    if (flags.json === true) console.log(JSON.stringify({ providers: [] }, null, 2))
    else console.log(`没有匹配 "${positional[0] ?? query}" 的供应商或模型`)
    process.exitCode = 1
    return
  }
  printList(rows, flags.json === true)
}

function commandShow(positional, flags) {
  rejectUnknownFlags("show", flags, new Set())
  const id = positional[0]
  if (!id) throw new CliError("用法：show <供应商id> [模型key]")
  const tree = loadTree(resolveRoot(flags))
  const entry = tree.providers.find((item) => item.id === id)
  if (!entry) {
    console.error(`✗ 供应商 "${id}" 不存在`)
    process.exitCode = 1
    return
  }
  const modelKey = positional[1]
  if (modelKey !== undefined) {
    const spec = entry.models[modelKey]
    if (!spec) {
      console.error(`✗ 供应商 "${id}" 下没有模型 "${modelKey}"（现有：${Object.keys(entry.models).join(", ") || "无"}）`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(spec, null, 2))
    return
  }
  console.log(JSON.stringify({ ...entry.provider, models: entry.models }, null, 2))
}

function commandValidate(flags) {
  rejectUnknownFlags("validate", flags, new Set())
  const root = resolveRoot(flags)
  let tree
  let registry
  try {
    tree = loadTree(root)
    registry = parseTree(tree)
  } catch (error) {
    if (error instanceof CliError) {
      reportFailure(root, [error.message])
      return
    }
    throw error
  }

  const problems = []
  const dirs = providerDirs(root)
  const inIndex = [...tree.manifest.providers].sort()
  if (JSON.stringify(inIndex) !== JSON.stringify(dirs)) {
    problems.push(`index.json 的 providers 与目录不一致：index=[${inIndex.join(", ")}] 目录=[${dirs.join(", ")}]`)
  }
  const expected = computeRevision(root)
  if (expected !== tree.manifest.revision) {
    problems.push(`revision 不一致：index=${tree.manifest.revision} 实际=${expected}（跑一次 sync 修正）`)
  }
  if (problems.length > 0) {
    reportFailure(root, problems)
    return
  }

  const providerCount = Object.keys(registry.providers).length
  const modelCount = Object.values(registry.providers).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0)
  const sharedCount = Object.keys(registry.models).length
  console.log(`✓ ${root}`)
  console.log(`  schemaVersion=${registry.schemaVersion} · 供应商=${providerCount} · 模型=${modelCount} · 顶层共享模型=${sharedCount} · revision=${tree.manifest.revision}`)
}

function reportFailure(root, problems) {
  console.error(`✗ ${root} 校验失败：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exitCode = 1
}

// ── 写命令 ──────────────────────────────────────────────────────────────────

function commandSync(flags) {
  rejectUnknownFlags("sync", flags, new Set())
  const root = resolveRoot(flags)
  const { providers, revision } = syncManifest(root)
  console.log(`✓ 已同步 ${join(root, "index.json")}`)
  console.log(`  providers=[${providers.join(", ")}] · revision=${revision}`)
}

const ADD_PROVIDER_FLAGS = new Set([
  "id", "name", "baseurl", "package", "protocol", "model",
  "model-name", "model-id", "context", "output", "variant", "base", "force", "input",
])

function commandAddProvider(flags) {
  rejectUnknownFlags("add-provider", flags, ADD_PROVIDER_FLAGS)
  const root = resolveRoot(flags)
  const tree = loadTree(root)
  const id = checkId(required(flags, "id", "供应商 id"), "供应商 id")
  const existing = tree.providers.find((entry) => entry.id === id)
  if (existing) {
    throw new CliError(
      `供应商 "${id}" 已存在（现有模型：${Object.keys(existing.models).join(", ") || "无"}）。\n` +
        `  要给它加模型请用：add-model --provider ${id} --key <模型key> …`,
    )
  }

  const name = required(flags, "name", "显示名称")
  const packageName = resolvePackage(flags)
  const baseURL = lastOf(flags, "baseurl")
  if (baseURL !== undefined && !/^https?:\/\/\S+$/i.test(String(baseURL))) {
    throw new CliError(`--baseurl "${baseURL}" 不是合法的 http(s) URL`)
  }
  if (baseURL !== undefined && flags.force !== true) {
    const clash = tree.providers.find((entry) => entry.provider.baseURL === baseURL)
    if (clash) throw new CliError(`baseURL "${baseURL}" 已被供应商 "${clash.id}" 使用（加 --force 可强制）`)
  }

  const modelKey = checkId(required(flags, "model", "首个模型 key"), "模型 key")
  const base = lastOf(flags, "base")
  if (base !== undefined) requireShared(tree, base)
  const spec = buildModelSpec(flags, { key: modelKey, allowBase: true })

  const provider = { name, package: packageName, ...(baseURL === undefined ? {} : { baseURL }) }
  // 落盘前校验整棵树。
  parseTree({ ...tree, providers: [...tree.providers, { id, provider, models: { [modelKey]: spec } }] })

  writeJsonFile(join(providerDir(root, id), "provider.json"), provider)
  writeJsonFile(join(providerDir(root, id), "models.json"), { [modelKey]: spec })
  syncManifest(root)

  console.log(`✓ 已添加供应商 "${id}"（${name}，${packageName}，1 个模型：${modelKey}）`)
  console.log(`  写入 ${providerDir(root, id)}/ 与 ${join(root, "index.json")}`)
}

const ADD_MODEL_FLAGS = new Set([
  "provider", "key", "model-name", "model-id", "context", "output", "variant", "base", "input",
])

function commandAddModel(flags) {
  rejectUnknownFlags("add-model", flags, ADD_MODEL_FLAGS)
  const root = resolveRoot(flags)
  const tree = loadTree(root)
  const providerId = checkId(required(flags, "provider", "供应商 id"), "供应商 id")
  const entry = tree.providers.find((item) => item.id === providerId)
  if (!entry) {
    throw new CliError(
      `供应商 "${providerId}" 不存在（现有：${tree.providers.map((item) => item.id).join(", ")}）。\n` +
        `  新增供应商请用：add-provider --id ${providerId} …`,
    )
  }
  const key = checkId(required(flags, "key", "模型 key"), "模型 key")
  if (entry.models[key]) {
    throw new CliError(`供应商 "${providerId}" 下已存在模型 "${key}"。本 CLI 不做覆盖/改名，请换 key 或先人工处理`)
  }
  const base = lastOf(flags, "base")
  if (base !== undefined) requireShared(tree, base)
  const spec = buildModelSpec(flags, { key, allowBase: true })

  const nextModels = { ...entry.models, [key]: spec }
  const providers = tree.providers.map((item) =>
    item.id === providerId ? { id: item.id, provider: item.provider, models: nextModels } : item,
  )
  parseTree({ ...tree, providers })

  writeJsonFile(join(providerDir(root, providerId), "models.json"), nextModels)
  syncManifest(root)

  console.log(`✓ 已给供应商 "${providerId}" 添加模型 "${key}"`)
  console.log(`  写入 ${providerDir(root, providerId)}/models.json 与 ${join(root, "index.json")}`)
}

function commandAddSharedModel(flags) {
  rejectUnknownFlags("add-shared-model", flags, new Set(["lab", "key", "model-name", "context", "output", "variant", "input"]))
  const root = resolveRoot(flags)
  const tree = loadTree(root)
  const lab = checkId(required(flags, "lab", "lab"), "lab")
  const key = checkId(required(flags, "key", "共享模型 key"), "共享模型 key")
  const ref = `${lab}/${key}`
  if (tree.shared.has(ref)) throw new CliError(`共享模型 "${ref}" 已存在`)

  const spec = buildModelSpec(flags, { key, allowBase: false })
  const shared = new Map(tree.shared)
  shared.set(ref, spec)
  parseTree({ ...tree, shared })

  writeJsonFile(sharedModelPath(root, ref), spec)
  syncManifest(root)

  console.log(`✓ 已添加共享模型 "${ref}"（用 add-model --base ${ref} 让供应商引用）`)
  console.log(`  写入 ${sharedModelPath(root, ref)} 与 ${join(root, "index.json")}`)
}

// ── 入口 ────────────────────────────────────────────────────────────────────

const USAGE = `分文件注册表维护 CLI —— agent 不要直接读整份注册表，用这些命令：

  node scripts/registry.mjs list [--json]
  node scripts/registry.mjs search <关键词> [--json]
  node scripts/registry.mjs show <供应商id> [模型key] [--json]
  node scripts/registry.mjs validate          # 组装 + schema + index/目录/revision 一致性
  node scripts/registry.mjs sync              # 重算 revision 并重写 index.json

  node scripts/registry.mjs add-provider --id ID --name 名称 --baseurl URL \\
      [--protocol chat|responses|messages | --package PKG] \\
      --model KEY [--model-name 名称] [--model-id 上游id] \\
      [--context N --output N] [--variant id[:settingsJSON]] [--base lab/model] [--force] \\
      [--input text,image,...]

  node scripts/registry.mjs add-model --provider ID --key KEY \\
      [--model-name 名称] [--model-id 上游id] \\
      [--context N --output N] [--variant id[:settingsJSON]] [--base lab/model] \\
      [--input text,image,...]

  node scripts/registry.mjs add-shared-model --lab LAB --key KEY \\
      [--model-name 名称] [--context N --output N] [--variant id[:settingsJSON]] \\
      [--input text,image,...]

通用：--root <注册表目录>；--json。`

function run(argv) {
  const { positional, flags } = parseArgs(argv)
  const command = positional.shift()
  switch (command) {
    case "list":
      return commandList(flags)
    case "search":
      return commandSearch(positional, flags)
    case "show":
      return commandShow(positional, flags)
    case "validate":
      return commandValidate(flags)
    case "sync":
      return commandSync(flags)
    case "add-provider":
      return commandAddProvider(flags)
    case "add-model":
      return commandAddModel(flags)
    case "add-shared-model":
      return commandAddSharedModel(flags)
    case "help":
    case undefined:
      console.log(USAGE)
      return
    default:
      throw new CliError(`未知命令 "${command}"\n\n${USAGE}`)
  }
}

function main() {
  try {
    run(process.argv.slice(2))
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`✗ ${error.message}`)
      process.exit(1)
    }
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()