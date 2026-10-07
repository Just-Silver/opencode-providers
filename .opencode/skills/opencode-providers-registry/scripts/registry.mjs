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
 *   <root>/models/<lab>/<model>.json   # 顶层共享模型（`--base` 复用那一层）
 *
 *   node scripts/registry.mjs list [--json]
 *   node scripts/registry.mjs search <关键词> [--json]
 *   node scripts/registry.mjs show <供应商id> [模型key] [--json]   # 或 show <lab>/<model> 看共享模型
 *   node scripts/registry.mjs validate
 *   node scripts/registry.mjs sync
 *   node scripts/registry.mjs add-provider --id ID --name 名称 --baseurl URL [--protocol chat] \
 *        --model KEY [--model-name 名称] [--model-id 上游id] [--context N --output N] [--variant id] [--base lab/model] [--force]
 *   node scripts/registry.mjs add-model --provider ID --key KEY [--model-name 名称] [--model-id 上游id] \
 *        [--context N --output N] [--variant id[:settingsJSON]] [--base lab/model] [--input text,image,...]
 *   node scripts/registry.mjs add-shared-model --lab LAB --key KEY [--model-name 名称] [--context N --output N] [--variant id[:settingsJSON]] [--input text,image,...]
 *   node scripts/registry.mjs set-provider --id ID [--name 名称] [--baseurl URL | --unset baseurl] [--package PKG | --protocol P]
 *   node scripts/registry.mjs set-model --provider ID --key KEY [--model-name 名称] [--model-id 上游id] \
 *        [--context N --output N] [--variant id[:settingsJSON]] [--input text,image,...] [--base lab/model] [--unset 字段]
 *   node scripts/registry.mjs set-shared-model --lab LAB --key KEY [--model-name 名称] [--context N --output N] \
 *        [--variant id[:settingsJSON]] [--input text,image,...] [--unset 字段]
 *   node scripts/registry.mjs remove-provider --id ID
 *   node scripts/registry.mjs remove-model --provider ID --key KEY
 *   node scripts/registry.mjs remove-shared-model --ref lab/model   # 或 --lab LAB --key KEY
 *
 * 更新一律是**字段补丁**：只改传入的 flag，未传字段保持原样；`--unset a,b` 显式清空（可重复给）。
 * 通用：`--root <注册表目录>` 覆盖默认位置；`--json` 输出机器可读结果。
 * 严格只写最小字段（供应商：name/package/baseURL；模型：name/modelID/limit/variants/base；能力：input），
 * 其余不写（keyLabel/settings/headers/cost/tools/output…）——注册表铁律由脚本强制。
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
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
  if (typeof input === "string" && input.trim() !== "") spec.input = parseInputList(input)

  return spec
}

/** `--input text,image` → `["text","image"]`（逗号分隔，逐项过路径段正则）。 */
function parseInputList(input) {
  const values = input
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
  if (values.length === 0) throw new CliError(`--input 不能为空`)
  for (const value of values) checkId(value, "--input 模态")
  return values
}

// ── 字段补丁（set-*） ────────────────────────────────────────────────────────

/** `--unset` 的别名 → 字段名。 */
const MODEL_UNSET_ALIASES = new Map([
  ["name", "name"],
  ["model-name", "name"],
  ["modelID", "modelID"],
  ["model-id", "modelID"],
  ["base", "base"],
  ["limit", "limit"],
  ["variants", "variants"],
  ["input", "input"],
])
const SHARED_UNSET_ALIASES = new Map([
  ["name", "name"],
  ["model-name", "name"],
  ["limit", "limit"],
  ["variants", "variants"],
  ["input", "input"],
])

/** 解析 `--unset a,b`（可重复给）；token 必须是已知字段，否则报错。 */
function parseUnsets(flags, aliases) {
  const tokens = allOf(flags, "unset")
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter((item) => item !== "")
  const fields = new Set()
  for (const token of tokens) {
    const field = aliases.get(token)
    if (!field) throw new CliError(`--unset ${token} 不支持（可选：${[...aliases.keys()].join(", ")}）`)
    fields.add(field)
  }
  return fields
}

/**
 * 字段补丁：只改传入的 flag，未传字段保持原样；`--unset` 显式清空。
 * 不在这里判「limit 缺失」等结构约束——统一交给落盘前的 `parseTree` 兜底。
 */
function applyModelPatch(tree, current, flags, { allowBase, allowModelID, aliases, key }) {
  const unsets = parseUnsets(flags, aliases)
  const spec = { ...current }

  const name = lastOf(flags, "model-name")
  if (name !== undefined) {
    if (typeof name !== "string" || name.trim() === "") throw new CliError(`--model-name 不能为空`)
    spec.name = name
  }
  if (unsets.has("name")) delete spec.name

  if (allowModelID) {
    const modelId = lastOf(flags, "model-id")
    if (modelId !== undefined) {
      if (typeof modelId !== "string" || modelId.trim() === "") throw new CliError(`--model-id 不能为空`)
      if (modelId === key) delete spec.modelID
      else spec.modelID = modelId
    }
    if (unsets.has("modelID")) delete spec.modelID
  }

  const context = lastOf(flags, "context")
  const output = lastOf(flags, "output")
  if (context !== undefined || output !== undefined) {
    if (context === undefined || output === undefined) {
      throw new CliError(`limit 要写就写全：--context 与 --output 必须同时给`)
    }
    spec.limit = { context: parsePositiveInt(context, "--context"), output: parsePositiveInt(output, "--output") }
  }
  if (unsets.has("limit")) delete spec.limit

  const variants = parseVariants(allOf(flags, "variant"))
  if (variants) spec.variants = variants
  if (unsets.has("variants")) delete spec.variants

  const input = lastOf(flags, "input")
  if (typeof input === "string" && input.trim() !== "") spec.input = parseInputList(input)
  if (unsets.has("input")) delete spec.input

  if (allowBase) {
    const base = lastOf(flags, "base")
    if (base !== undefined) spec.base = requireShared(tree, base)
    if (unsets.has("base")) delete spec.base
  }

  return spec
}

// ── 重复定义提示（软提示，不拦截） ──────────────────────────────────────────

/** 参与「参数相同」比较的字段（固定顺序 → JSON 串稳定可比较）。 */
const COMPARABLE_FIELDS = [
  "name", "family", "releaseDate", "status", "disabled",
  "limit", "cost", "tools", "input", "output", "reasoningField", "maxTokensField", "variants",
]

function comparableModel(value) {
  const out = {}
  for (const field of COMPARABLE_FIELDS) if (value[field] !== undefined) out[field] = value[field]
  return JSON.stringify(out)
}

/** 找到一个与 spec（忽略 `base`/`modelID`）参数完全相同的共享模型引用。 */
function findIdenticalShared(tree, spec) {
  if (spec.base !== undefined) return undefined
  const target = comparableModel(spec)
  for (const [ref, model] of tree.shared) if (comparableModel(model) === target) return ref
  return undefined
}

function reportReuseHint(tree, spec) {
  const ref = findIdenticalShared(tree, spec)
  if (ref !== undefined) {
    console.log(`  ⚠ 提示：共享模型 "${ref}" 参数与刚写入的相同，可改用 --base ${ref} 复用（避免重复定义）`)
  }
}

/** 删掉空目录（共享模型删光后残留的 lab 目录）。非空/占用则静默保留。 */
function removeEmptyDir(dir) {
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir)
  } catch {
    /* 非空或占用 → 保留 */
  }
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

/** 顶层共享模型（可被 `--base` 复用的那一层）+ 谁在引用它。 */
function summarizeShared(registry) {
  const usedBy = new Map()
  for (const [id, provider] of Object.entries(registry.providers)) {
    for (const spec of Object.values(provider.models ?? {})) {
      if (!spec.base) continue
      const list = usedBy.get(spec.base) ?? []
      list.push(id)
      usedBy.set(spec.base, list)
    }
  }
  return Object.entries(registry.models ?? {}).map(([ref, model]) => ({
    ref,
    name: model.name,
    family: model.family,
    limit: model.limit,
    variants: (model.variants ?? []).map((variant) => variant.id),
    input: model.input,
    usedBy: usedBy.get(ref) ?? [],
  }))
}

function printProviders(rows) {
  if (rows.length === 0) return
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

function printSharedModels(rows) {
  if (rows.length === 0) return
  console.log(`顶层共享模型（${rows.length}）——新增模型命中这里时可用 --base 复用：\n`)
  for (const row of rows) {
    const parts = []
    if (row.name) parts.push(`(${row.name})`)
    if (row.limit) parts.push(`ctx=${row.limit.context} out=${row.limit.output}`)
    if (row.variants.length) parts.push(`variants=${row.variants.join(",")}`)
    if (row.usedBy.length) parts.push(`← ${row.usedBy.join(", ")}`)
    console.log(`  ${row.ref}  ${parts.join("  ")}`)
  }
  console.log("")
}

function printResult(providers, shared, json) {
  if (json) {
    console.log(JSON.stringify({ providers, sharedModels: shared }, null, 2))
    return
  }
  if (providers.length === 0 && shared.length === 0) {
    console.log("（注册表里没有供应商，也没有顶层共享模型）")
    return
  }
  printProviders(providers)
  printSharedModels(shared)
}

function matchesModel(model, query) {
  return [model.key, model.modelID, model.name]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().includes(query))
}

function matchesShared(row, query) {
  return [row.ref, row.name, row.family]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().includes(query))
}

function commandList(flags) {
  rejectUnknownFlags("list", flags, new Set())
  const registry = parseTree(loadTree(resolveRoot(flags)))
  printResult(summarize(registry), summarizeShared(registry), flags.json === true)
}

function commandSearch(positional, flags) {
  rejectUnknownFlags("search", flags, new Set(["query"]))
  const query = (positional[0] ?? lastOf(flags, "query") ?? "").toLowerCase()
  if (!query) throw new CliError("用法：search <关键词>")
  const registry = parseTree(loadTree(resolveRoot(flags)))
  const shared = summarizeShared(registry).filter((row) => matchesShared(row, query))
  const rows = []
  for (const row of summarize(registry)) {
    const providerHit = row.id.toLowerCase().includes(query) || String(row.name).toLowerCase().includes(query)
    const models = providerHit ? row.models : row.models.filter((model) => matchesModel(model, query))
    if (providerHit || models.length > 0) rows.push({ ...row, models })
  }
  if (rows.length === 0 && shared.length === 0) {
    if (flags.json === true) console.log(JSON.stringify({ providers: [], sharedModels: [] }, null, 2))
    else console.log(`没有匹配 "${positional[0] ?? query}" 的供应商、模型或共享模型`)
    process.exitCode = 1
    return
  }
  printResult(rows, shared, flags.json === true)
}

function commandShow(positional, flags) {
  rejectUnknownFlags("show", flags, new Set())
  const id = positional[0]
  if (!id) throw new CliError("用法：show <供应商id> [模型key]（或 show <lab>/<model> 看顶层共享模型）")
  const tree = loadTree(resolveRoot(flags))
  // 供应商 id 不含 `/`；含 `/` 的一律按 `<lab>/<model>` 解析成共享模型引用。
  if (id.includes("/")) {
    const ref = checkBaseRef(id)
    const model = tree.shared.get(ref)
    if (!model) {
      console.error(`✗ 共享模型 "${ref}" 不存在（现有：${[...tree.shared.keys()].join(", ") || "无"}）`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(model, null, 2))
    return
  }
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
  reportReuseHint(tree, spec)
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
  reportReuseHint(tree, spec)
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

const SET_PROVIDER_FLAGS = new Set(["id", "name", "baseurl", "package", "protocol", "unset", "force"])

function commandSetProvider(flags) {
  rejectUnknownFlags("set-provider", flags, SET_PROVIDER_FLAGS)
  const root = resolveRoot(flags)
  const tree = loadTree(root)
  const id = checkId(required(flags, "id", "供应商 id"), "供应商 id")
  const entry = tree.providers.find((item) => item.id === id)
  if (!entry) throw new CliError(`供应商 "${id}" 不存在（现有：${tree.providers.map((item) => item.id).join(", ")}）`)

  const unsets = parseUnsets(flags, new Map([["baseurl", "baseurl"], ["base-url", "baseurl"]]))
  const provider = { ...entry.provider }

  const name = lastOf(flags, "name")
  if (name !== undefined) {
    if (typeof name !== "string" || name.trim() === "") throw new CliError(`--name 不能为空`)
    provider.name = name
  }
  if (lastOf(flags, "package") !== undefined || lastOf(flags, "protocol") !== undefined) {
    provider.package = resolvePackage(flags)
  }
  const baseURL = lastOf(flags, "baseurl")
  if (baseURL !== undefined) {
    if (!/^https?:\/\/\S+$/i.test(String(baseURL))) throw new CliError(`--baseurl "${baseURL}" 不是合法的 http(s) URL`)
    if (flags.force !== true) {
      const clash = tree.providers.find((item) => item.id !== id && item.provider.baseURL === baseURL)
      if (clash) throw new CliError(`baseURL "${baseURL}" 已被供应商 "${clash.id}" 使用（加 --force 可强制）`)
    }
    provider.baseURL = baseURL
  }
  if (unsets.has("baseurl")) delete provider.baseURL

  const providers = tree.providers.map((item) => (item.id === id ? { id, provider, models: item.models } : item))
  parseTree({ ...tree, providers })

  writeJsonFile(join(providerDir(root, id), "provider.json"), provider)
  syncManifest(root)
  console.log(`✓ 已更新供应商 "${id}"（${provider.name}）`)
  console.log(`  写入 ${providerDir(root, id)}/provider.json 与 ${join(root, "index.json")}`)
}

const SET_MODEL_FLAGS = new Set([
  "provider", "key", "model-name", "model-id", "context", "output", "variant", "base", "input", "unset",
])

function commandSetModel(flags) {
  rejectUnknownFlags("set-model", flags, SET_MODEL_FLAGS)
  const root = resolveRoot(flags)
  const tree = loadTree(root)
  const providerId = checkId(required(flags, "provider", "供应商 id"), "供应商 id")
  const entry = tree.providers.find((item) => item.id === providerId)
  if (!entry) throw new CliError(`供应商 "${providerId}" 不存在（现有：${tree.providers.map((item) => item.id).join(", ")}）`)
  const key = checkId(required(flags, "key", "模型 key"), "模型 key")
  const current = entry.models[key]
  if (!current) throw new CliError(`供应商 "${providerId}" 下没有模型 "${key}"（现有：${Object.keys(entry.models).join(", ") || "无"}）`)

  const spec = applyModelPatch(tree, current, flags, {
    allowBase: true,
    allowModelID: true,
    aliases: MODEL_UNSET_ALIASES,
    key,
  })
  const nextModels = { ...entry.models, [key]: spec }
  const providers = tree.providers.map((item) =>
    item.id === providerId ? { id: item.id, provider: item.provider, models: nextModels } : item,
  )
  parseTree({ ...tree, providers })

  writeJsonFile(join(providerDir(root, providerId), "models.json"), nextModels)
  syncManifest(root)
  console.log(`✓ 已更新供应商 "${providerId}" 的模型 "${key}"`)
  console.log(`  写入 ${providerDir(root, providerId)}/models.json 与 ${join(root, "index.json")}`)
}

const SET_SHARED_FLAGS = new Set(["lab", "key", "model-name", "context", "output", "variant", "input", "unset"])

function commandSetSharedModel(flags) {
  rejectUnknownFlags("set-shared-model", flags, SET_SHARED_FLAGS)
  const root = resolveRoot(flags)
  const tree = loadTree(root)
  const lab = checkId(required(flags, "lab", "lab"), "lab")
  const key = checkId(required(flags, "key", "共享模型 key"), "共享模型 key")
  const ref = `${lab}/${key}`
  const current = tree.shared.get(ref)
  if (!current) throw new CliError(`共享模型 "${ref}" 不存在（现有：${[...tree.shared.keys()].join(", ") || "无"}）`)

  const spec = applyModelPatch(tree, current, flags, {
    allowBase: false,
    allowModelID: false,
    aliases: SHARED_UNSET_ALIASES,
    key,
  })
  const shared = new Map(tree.shared)
  shared.set(ref, spec)
  parseTree({ ...tree, shared })

  writeJsonFile(sharedModelPath(root, ref), spec)
  syncManifest(root)
  const used = tree.providers
    .filter((item) => Object.values(item.models).some((model) => model.base === ref))
    .map((item) => item.id)
  console.log(`✓ 已更新共享模型 "${ref}"`)
  if (used.length > 0) console.log(`  ⚠ 改动对引用它的供应商同时生效：${used.join(", ")}`)
  console.log(`  写入 ${sharedModelPath(root, ref)} 与 ${join(root, "index.json")}`)
}

function commandRemoveProvider(flags) {
  rejectUnknownFlags("remove-provider", flags, new Set(["id"]))
  const root = resolveRoot(flags)
  const tree = loadTree(root)
  const id = checkId(required(flags, "id", "供应商 id"), "供应商 id")
  const entry = tree.providers.find((item) => item.id === id)
  if (!entry) throw new CliError(`供应商 "${id}" 不存在（现有：${tree.providers.map((item) => item.id).join(", ")}）`)
  if (tree.providers.length === 1) {
    throw new CliError(`"${id}" 是唯一的供应商；删掉会让注册表没有供应商（schema 不允许）`)
  }

  const providers = tree.providers.filter((item) => item.id !== id)
  parseTree({ ...tree, providers })

  rmSync(providerDir(root, id), { recursive: true, force: true })
  syncManifest(root)
  console.log(`✓ 已删除供应商 "${id}"（${entry.provider.name}，${Object.keys(entry.models).length} 个模型）`)
  console.log(`  删除 ${providerDir(root, id)}/ 并重写 ${join(root, "index.json")}`)

  const orphans = [...tree.shared.keys()].filter(
    (ref) => !providers.some((item) => Object.values(item.models).some((model) => model.base === ref)),
  )
  if (orphans.length > 0) {
    console.log(`  提示：以下共享模型已无人引用（可保留，或用 remove-shared-model 删除）：${orphans.join(", ")}`)
  }
}

function commandRemoveModel(flags) {
  rejectUnknownFlags("remove-model", flags, new Set(["provider", "key"]))
  const root = resolveRoot(flags)
  const tree = loadTree(root)
  const providerId = checkId(required(flags, "provider", "供应商 id"), "供应商 id")
  const entry = tree.providers.find((item) => item.id === providerId)
  if (!entry) throw new CliError(`供应商 "${providerId}" 不存在（现有：${tree.providers.map((item) => item.id).join(", ")}）`)
  const key = checkId(required(flags, "key", "模型 key"), "模型 key")
  if (!entry.models[key]) {
    throw new CliError(`供应商 "${providerId}" 下没有模型 "${key}"（现有：${Object.keys(entry.models).join(", ") || "无"}）`)
  }
  if (Object.keys(entry.models).length === 1) {
    throw new CliError(
      `"${key}" 是供应商 "${providerId}" 唯一的模型；删掉会让它变空（schema 不允许）。要删整家请用 remove-provider --id ${providerId}`,
    )
  }

  const nextModels = { ...entry.models }
  delete nextModels[key]
  const providers = tree.providers.map((item) =>
    item.id === providerId ? { id: item.id, provider: item.provider, models: nextModels } : item,
  )
  parseTree({ ...tree, providers })

  writeJsonFile(join(providerDir(root, providerId), "models.json"), nextModels)
  syncManifest(root)
  console.log(`✓ 已从供应商 "${providerId}" 删除模型 "${key}"`)
  console.log(`  写入 ${providerDir(root, providerId)}/models.json 与 ${join(root, "index.json")}`)
}

function commandRemoveSharedModel(flags) {
  rejectUnknownFlags("remove-shared-model", flags, new Set(["ref", "lab", "key"]))
  const root = resolveRoot(flags)
  const tree = loadTree(root)
  const rawRef = lastOf(flags, "ref")
  const ref = checkBaseRef(
    typeof rawRef === "string" && rawRef.trim() !== ""
      ? rawRef
      : `${checkId(required(flags, "lab", "lab"), "lab")}/${checkId(required(flags, "key", "共享模型 key"), "共享模型 key")}`,
  )
  if (!tree.shared.has(ref)) {
    throw new CliError(`共享模型 "${ref}" 不存在（现有：${[...tree.shared.keys()].join(", ") || "无"}）`)
  }

  // 悬空引用会让引用它的供应商在插件里被整家跳过 —— 先挡住，避免制造坏数据。
  const referrers = []
  for (const entry of tree.providers) {
    for (const [key, spec] of Object.entries(entry.models)) {
      if (spec.base === ref) referrers.push(`${entry.id}/${key}`)
    }
  }
  if (referrers.length > 0) {
    throw new CliError(
      `共享模型 "${ref}" 仍被引用：${referrers.join(", ")}。\n` +
        `  先用 set-model --provider <id> --key <key> --unset base（或 remove-model）解除引用，再删——否则会留下未知 base`,
    )
  }

  const shared = new Map(tree.shared)
  shared.delete(ref)
  parseTree({ ...tree, shared })

  const path = sharedModelPath(root, ref)
  rmSync(path, { force: true })
  removeEmptyDir(dirname(path))
  syncManifest(root)
  console.log(`✓ 已删除共享模型 "${ref}"`)
  console.log(`  删除 ${path} 并重写 ${join(root, "index.json")}`)
}

// ── 检查（check） ───────────────────────────────────────────────────────────

function commandCheck(flags) {
  rejectUnknownFlags("check", flags, new Set(["strict"]))
  const root = resolveRoot(flags)
  let tree
  try {
    tree = loadTree(root)
  } catch (error) {
    if (error instanceof CliError) {
      reportFailure(root, [error.message])
      return
    }
    throw error
  }

  const errors = []
  const warnings = []

  // 1) 分文件能否聚合 + 过 schema（含 base 引用、字段合法性等）
  const parsed = parseRegistry(assemble(tree))
  if (!parsed.ok) errors.push(...parsed.errors)

  // 2) manifest / 目录 / revision 一致
  const dirs = providerDirs(root)
  const inIndex = [...tree.manifest.providers].sort()
  if (JSON.stringify(inIndex) !== JSON.stringify(dirs)) {
    errors.push(`index.json 的 providers 与目录不一致：index=[${inIndex.join(", ")}] 目录=[${dirs.join(", ")}]`)
  }
  const expected = computeRevision(root)
  if (expected !== tree.manifest.revision) {
    errors.push(`revision 不一致：index=${tree.manifest.revision} 实际=${expected}（跑一次 sync 修正）`)
  }

  // 3) 共享模型引用完整性：悬空=error、孤儿=warn
  const referrers = new Map()
  for (const entry of tree.providers) {
    for (const [key, spec] of Object.entries(entry.models)) {
      if (spec.base === undefined) continue
      const list = referrers.get(spec.base) ?? []
      list.push(`${entry.id}/${key}`)
      referrers.set(spec.base, list)
    }
  }
  for (const [ref, users] of referrers) {
    if (!tree.shared.has(ref)) {
      errors.push(`悬空引用：共享模型 "${ref}" 不存在，却被 ${users.join(", ")} 引用（该家会被运行期整家跳过）`)
    }
  }
  for (const ref of tree.shared.keys()) {
    if (!referrers.has(ref)) warnings.push(`未被引用的共享模型 "${ref}"（可保留，或用 remove-shared-model 删除）`)
  }

  // 4) 内联模型与某共享模型参数完全相同 → 建议改用 base 复用
  for (const entry of tree.providers) {
    for (const [key, spec] of Object.entries(entry.models)) {
      if (spec.base !== undefined) continue
      const ref = findIdenticalShared(tree, spec)
      if (ref !== undefined) {
        warnings.push(`providers/${entry.id}/models.json 的 "${key}" 与共享模型 "${ref}" 参数相同，建议改用 base 复用`)
      }
    }
  }

  // 5) baseURL 重复
  const byUrl = new Map()
  for (const entry of tree.providers) {
    const url = entry.provider.baseURL
    if (typeof url !== "string" || url === "") continue
    const list = byUrl.get(url) ?? []
    list.push(entry.id)
    byUrl.set(url, list)
  }
  for (const [url, ids] of byUrl) {
    if (ids.length > 1) warnings.push(`baseURL "${url}" 被多家使用：${ids.join(", ")}`)
  }

  // 6) 输入模态：写了 input 却不含 text
  const checkInput = (where, input) => {
    if (Array.isArray(input) && !input.includes("text")) warnings.push(`${where} 的 input 不含 "text"：${input.join(",")}`)
  }
  for (const entry of tree.providers) {
    for (const [key, spec] of Object.entries(entry.models)) {
      checkInput(`providers/${entry.id}/models.json 的 "${key}"`, spec.input)
    }
  }
  for (const [ref, model] of tree.shared) checkInput(`共享模型 "${ref}"`, model.input)

  // 7) 空 lab 目录残留
  const modelsRoot = join(root, "models")
  if (existsSync(modelsRoot)) {
    for (const entry of readdirSync(modelsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && readdirSync(join(modelsRoot, entry.name)).length === 0) {
        warnings.push(`空目录残留：models/${entry.name}/（无文件）`)
      }
    }
  }

  const modelCount = tree.providers.reduce((sum, entry) => sum + Object.keys(entry.models).length, 0)
  if (errors.length > 0) {
    console.error(`✗ ${root} 检查失败：`)
    for (const problem of errors) console.error(`  - ${problem}`)
    for (const problem of warnings) console.error(`  ⚠ ${problem}`)
    process.exitCode = 1
    return
  }
  console.log(`✓ ${root} 检查通过`)
  console.log(`  供应商=${tree.providers.length} · 模型=${modelCount} · 顶层共享模型=${tree.shared.size} · revision=${tree.manifest.revision}`)
  if (warnings.length > 0) {
    console.log(`  ${warnings.length} 条提醒：`)
    for (const problem of warnings) console.log(`  ⚠ ${problem}`)
    if (flags.strict === true) {
      console.error(`✗ --strict：${warnings.length} 条提醒视为失败`)
      process.exitCode = 1
    }
  }
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