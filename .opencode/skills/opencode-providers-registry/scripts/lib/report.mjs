/**
 * 只读输出的汇总与打印：供应商 / 顶层共享模型 / 失败报告。
 */

import { resolveModelSpec } from "../../../../../plugin/opencode-providers/registry/schema.ts"

export function summarize(registry) {
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
export function summarizeShared(registry) {
  const usedBy = new Map()
  for (const [id, provider] of Object.entries(registry.providers)) {
    for (const spec of Object.values(provider.models ?? {})) {
      if (!spec.base) continue
      const list = usedBy.get(spec.base) ?? []
      // 同一家可有多个模型引用同一 canon；引用方按**供应商**去重，别出现 "r4-coder, r4-coder"
      if (!list.includes(id)) list.push(id)
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
    // `search` 会区分「供应商 id/名称命中」与「模型命中」，避免把供应商命中误读成可 --base 的共享模型候选
    const hit = row.providerHit ? "  〔供应商 id/名称命中〕" : ""
    console.log(`${row.id} (${row.name}) · ${row.package} · ${row.baseURL ?? "(无 baseURL)"} · ${row.models.length} 个模型${hit}`)
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

export function printResult(providers, shared, json) {
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

/** 宽松匹配用的归一化：小写，把 `. _ / \ 空白 :` 折成 `-`，去首尾 `-`。 */
export function normalizeKey(value) {
  return String(value)
    .toLowerCase()
    .replace(/[._\/\\\s:]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** 归一化后分词，丢掉纯数字与单字符 token（版本号/噪声不参与宽松召回）。 */
function significantTokens(normalized) {
  return normalized.split("-").filter((token) => token.length >= 2 && !/^\d+$/.test(token))
}

/**
 * 匹配：归一化后整体互为子串（精确路径），或查询的**全部**「显著 token」都命中候选字段（AND）。
 *
 * 全 token AND 是硬要求：系列词（flash / air / mini / pro …）跨家族共用，若按「任一 token」（OR）
 * 命中，查询 `glm-5.3-flash` 会因共有 token `flash` 把 `deepseek-v4.1-flash` 一并召回；
 * AND 要求查询里的家族词（glm）也命中，跨家族同系列模型自然出局。
 * **无兜底**：AND 零命中就是零命中（提示「没有匹配」、退出码 1，走「问 lab / 新增」流程），
 * 不回退 OR——回退会让系列词误召复发。
 * 命中可能多个——由技能用 `multiple` 的 `question` 让用户二次确认真实家族。
 */
export function matchesQuery(query, fields) {
  const normalized = normalizeKey(query)
  if (!normalized) return false
  const tokens = significantTokens(normalized)
  return fields
    .filter((field) => field !== undefined && field !== null && field !== "")
    .some((field) => {
      const target = normalizeKey(field)
      if (target === "") return false
      if (target.includes(normalized)) return true
      return tokens.length > 0 && tokens.every((token) => target.includes(token))
    })
}

export function matchesModel(model, query) {
  return matchesQuery(query, [model.key, model.modelID, model.name])
}

export function matchesShared(row, query) {
  return matchesQuery(query, [row.ref, row.name, row.family])
}

export function reportFailure(root, problems) {
  console.error(`✗ ${root} 校验失败：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exitCode = 1
}
