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

export function matchesModel(model, query) {
  return [model.key, model.modelID, model.name]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().includes(query))
}

export function matchesShared(row, query) {
  return [row.ref, row.name, row.family]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().includes(query))
}

export function reportFailure(root, problems) {
  console.error(`✗ ${root} 校验失败：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exitCode = 1
}
