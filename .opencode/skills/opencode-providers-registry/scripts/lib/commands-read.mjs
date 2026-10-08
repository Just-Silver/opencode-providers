/**
 * 只读命令：list / search / show / validate / check。
 */

import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { parseRegistry } from "../../../../../plugin/opencode-providers/registry/schema.ts"
import { CliError, checkBaseRef, lastOf, rejectUnknownFlags } from "./cli.mjs"
import { assemble, computeRevision, loadTree, parseTree, providerDirs, resolveRoot } from "./store.mjs"
import { comparableFields, findIdenticalShared, sameValue } from "./spec.mjs"
import { matchesModel, matchesQuery, matchesShared, printResult, reportFailure, summarize, summarizeShared } from "./report.mjs"

export function commandList(flags) {
  rejectUnknownFlags("list", flags, new Set())
  const registry = parseTree(loadTree(resolveRoot(flags)))
  printResult(summarize(registry), summarizeShared(registry), flags.json === true)
}

export function commandSearch(positional, flags) {
  rejectUnknownFlags("search", flags, new Set(["query"]))
  const query = (positional[0] ?? lastOf(flags, "query") ?? "").toLowerCase()
  if (!query) throw new CliError("用法：search <关键词>")
  const registry = parseTree(loadTree(resolveRoot(flags)))
  const shared = summarizeShared(registry).filter((row) => matchesShared(row, query))
  const rows = []
  for (const row of summarize(registry)) {
    const providerHit = matchesQuery(query, [row.id, row.name])
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

export function commandShow(positional, flags) {
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

export function commandValidate(flags) {
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

/** 比 `validate` 更全：除了结构错误，还报一串可维护性提醒（`--strict` 时提醒也算失败）。 */
export function commandCheck(flags) {
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

  // 4b) 两个 canon 参数完全相同 → 可能是重复家族
  const sharedComparables = [...tree.shared].map(([ref, model]) => [ref, comparableFields(model)])
  for (let i = 0; i < sharedComparables.length; i += 1) {
    for (let j = i + 1; j < sharedComparables.length; j += 1) {
      if (sameValue(sharedComparables[i][1], sharedComparables[j][1])) {
        warnings.push(`参数完全相同的共享模型："${sharedComparables[i][0]}" 与 "${sharedComparables[j][0]}"（可能重复家族；确认后删其一）`)
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
