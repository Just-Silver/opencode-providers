/**
 * 模型 spec 的构造（add-*）与字段补丁（set-*），以及「重复定义」软提示。
 *
 * 铁律：只产生最小字段（name/modelID/limit/variants/base/input），其余不写。
 */

import { existsSync, readdirSync, rmdirSync } from "node:fs"

import { CliError, allOf, checkId, isPlainObject, lastOf, parsePositiveInt } from "./cli.mjs"
import { requireShared } from "./store.mjs"

/** 协议形态 → package（默认 chat）。 */
export const PROTOCOL_PACKAGES = {
  chat: "@opencode/ai/providers/openai-compatible",
  responses: "@opencode/ai/providers/openai-compatible/responses",
  messages: "@opencode/ai/providers/anthropic-compatible",
}
const DEFAULT_PROTOCOL = "chat"

export function resolvePackage(flags) {
  const raw = lastOf(flags, "package")
  if (typeof raw === "string" && raw.trim() !== "") return raw
  const protocol = lastOf(flags, "protocol") ?? DEFAULT_PROTOCOL
  const mapped = PROTOCOL_PACKAGES[protocol]
  if (!mapped) throw new CliError(`--protocol 只支持 ${Object.keys(PROTOCOL_PACKAGES).join(" / ")}，收到 ${JSON.stringify(protocol)}`)
  return mapped
}

export function parseVariants(rawVariants) {
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

/** `--input text,image` → `["text","image"]`（逗号分隔，逐项过路径段正则）。 */
export function parseInputList(input) {
  const values = input
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
  if (values.length === 0) throw new CliError(`--input 不能为空`)
  for (const value of values) checkId(value, "--input 模态")
  return values
}

/** 由命令行 flags 构造一个最小字段的模型 spec（供应商内联 or 顶层共享）。 */
export function buildModelSpec(flags, { key, allowBase, allowModelID = true }) {
  const spec = {}
  const base = lastOf(flags, "base")
  if (base !== undefined) {
    if (!allowBase) throw new CliError(`--base 只能用于供应商模型（共享模型不能再引用 base）`)
    spec.base = base
  }

  const name = lastOf(flags, "model-name")
  if (typeof name === "string" && name.trim() !== "") spec.name = name

  if (allowModelID) {
    const modelId = lastOf(flags, "model-id")
    if (typeof modelId === "string" && modelId.trim() !== "" && modelId !== key) spec.modelID = modelId
  }

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

/**
 * 解析「模型来源」三选一：--lab（建 canon）/ --base（复用）/ --inline（本家独有）。
 * 恰好给一个；返回 { canon?, providerSpec }（canon 仅在 --lab 时存在）。
 * 必须在既有的身份/重复校验之后调用。
 */
export function resolveModelSource(tree, flags, { key }) {
  const lab = lastOf(flags, "lab")
  const hasLab = typeof lab === "string" && lab.trim() !== ""
  const hasBase = lastOf(flags, "base") !== undefined
  const hasInline = flags.inline === true || flags.inline === "true"
  const count = [hasLab, hasBase, hasInline].filter(Boolean).length
  if (count === 0) {
    throw new CliError(`必须指定模型来源：--lab <lab>（建共享模型）/ --base <lab>/<model>（复用）/ --inline（本家独有）`)
  }
  if (count > 1) throw new CliError(`--lab / --base / --inline 只能给一个`)

  if (hasLab) {
    const ref = `${checkId(lab, "lab")}/${checkId(lastOf(flags, "lab-key") ?? key, "共享模型 key")}`
    if (tree.shared.has(ref)) throw new CliError(`共享模型 "${ref}" 已存在，请改用 --base ${ref} 复用`)
    const canon = buildModelSpec(flags, { key: ref.split("/")[1], allowBase: false, allowModelID: false })
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

// ── 字段补丁（set-*） ──────────────────────────────────────────────────────

/** `--unset` 的别名 → 字段名。 */
export const MODEL_UNSET_ALIASES = new Map([
  ["name", "name"],
  ["model-name", "name"],
  ["modelID", "modelID"],
  ["model-id", "modelID"],
  ["base", "base"],
  ["limit", "limit"],
  ["variants", "variants"],
  ["input", "input"],
])
export const SHARED_UNSET_ALIASES = new Map([
  ["name", "name"],
  ["model-name", "name"],
  ["limit", "limit"],
  ["variants", "variants"],
  ["input", "input"],
])

/** 解析 `--unset a,b`（可重复给）；token 必须是已知字段，否则报错。 */
export function parseUnsets(flags, aliases) {
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
export function applyModelPatch(tree, current, flags, { allowBase, allowModelID, aliases, key }) {
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

// ── 重复定义提示（软提示，不拦截） ────────────────────────────────────────

/** 参与「参数相同」比较的字段（固定顺序 → JSON 串稳定可比较）。 */
const COMPARABLE_FIELDS = [
  "name", "family", "releaseDate", "status", "disabled",
  "limit", "cost", "tools", "input", "output", "reasoningField", "maxTokensField", "variants",
]

function comparableFields(value) {
  const out = {}
  for (const field of COMPARABLE_FIELDS) if (value[field] !== undefined) out[field] = value[field]
  return out
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * 找到一个「参数相同」的共享模型引用：内联模型**已写的字段**都要在共享模型里对得上
 * （子集匹配 —— 共享模型多带的 `family`/`output` 等不算差异）。忽略 `base`/`modelID`。
 */
export function findIdenticalShared(tree, spec) {
  if (spec.base !== undefined) return undefined
  const fields = comparableFields(spec)
  const keys = Object.keys(fields)
  if (keys.length === 0) return undefined
  for (const [ref, model] of tree.shared) {
    if (keys.every((field) => model[field] !== undefined && sameValue(model[field], fields[field]))) return ref
  }
  return undefined
}

export function reportReuseHint(tree, spec) {
  const ref = findIdenticalShared(tree, spec)
  if (ref !== undefined) {
    console.log(`  ⚠ 提示：共享模型 "${ref}" 参数与刚写入的相同，可改用 --base ${ref} 复用（避免重复定义）`)
  }
}

/** 删掉空目录（共享模型删光后残留的 lab 目录）。非空/占用则静默保留。 */
export function removeEmptyDir(dir) {
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir)
  } catch {
    /* 非空或占用 → 保留 */
  }
}
