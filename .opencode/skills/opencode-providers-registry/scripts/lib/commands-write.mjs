/**
 * 写命令：sync / add-* / set-* / remove-*。
 * 一律「先组装校验、后落盘」，且写完重算 revision 与 index.json。
 */

import { rmSync } from "node:fs"
import { dirname, join } from "node:path"

import { CliError, checkBaseRef, checkId, lastOf, rejectUnknownFlags, required } from "./cli.mjs"
import {
  loadTree,
  parseTree,
  providerDir,
  resolveRoot,
  sharedModelPath,
  syncManifest,
  writeJsonFile,
} from "./store.mjs"
import {
  MODEL_UNSET_ALIASES,
  SHARED_UNSET_ALIASES,
  applyModelPatch,
  buildModelSpec,
  parseUnsets,
  removeEmptyDir,
  reportReuseHint,
  resolveModelSource,
  resolvePackage,
} from "./spec.mjs"

/** 删掉已无人引用的共享模型文件（含空 lab 目录），返回被删的 ref 列表。必须在 syncManifest 之前调用。 */
function deleteOrphanShared(root, shared, providers) {
  const orphans = [...shared.keys()].filter(
    (ref) => !providers.some((item) => Object.values(item.models).some((model) => model.base === ref)),
  )
  for (const ref of orphans) {
    const path = sharedModelPath(root, ref)
    rmSync(path, { force: true })
    removeEmptyDir(dirname(path))
  }
  return orphans
}

export function commandSync(flags) {
  rejectUnknownFlags("sync", flags, new Set())
  const root = resolveRoot(flags)
  const { providers, revision } = syncManifest(root)
  console.log(`✓ 已同步 ${join(root, "index.json")}`)
  console.log(`  providers=[${providers.join(", ")}] · revision=${revision}`)
}

const ADD_PROVIDER_FLAGS = new Set([
  "id", "name", "baseurl", "package", "protocol", "model",
  "model-name", "model-id", "context", "output", "variant", "base", "force", "input",
  "lab", "lab-key", "inline",
])

export function commandAddProvider(flags) {
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
  const { canon, providerSpec } = resolveModelSource(tree, flags, { key: modelKey })

  const provider = { name, package: packageName, ...(baseURL === undefined ? {} : { baseURL }) }
  const shared = canon ? new Map([...tree.shared, [canon.ref, canon.spec]]) : tree.shared
  // 落盘前校验整棵树。
  parseTree({ ...tree, providers: [...tree.providers, { id, provider, models: { [modelKey]: providerSpec } }], shared })

  writeJsonFile(join(providerDir(root, id), "provider.json"), provider)
  if (canon) writeJsonFile(sharedModelPath(root, canon.ref), canon.spec)
  writeJsonFile(join(providerDir(root, id), "models.json"), { [modelKey]: providerSpec })
  syncManifest(root)

  if (canon) console.log(`✓ 已添加供应商 "${id}"（${name}，${packageName}）并建共享模型 "${canon.ref}"，首个模型 "${modelKey}" 引用它`)
  else console.log(`✓ 已添加供应商 "${id}"（${name}，${packageName}，1 个模型：${modelKey}）`)
  console.log(`  写入 ${providerDir(root, id)}/ 与 ${join(root, "index.json")}`)
  reportReuseHint(tree, providerSpec)
}

const ADD_MODEL_FLAGS = new Set([
  "provider", "key", "model-name", "model-id", "context", "output", "variant", "base", "input",
  "lab", "lab-key", "inline",
])

export function commandAddModel(flags) {
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
  const { canon, providerSpec } = resolveModelSource(tree, flags, { key })

  const nextModels = { ...entry.models, [key]: providerSpec }
  const providers = tree.providers.map((item) =>
    item.id === providerId ? { id: item.id, provider: item.provider, models: nextModels } : item,
  )
  const shared = canon ? new Map([...tree.shared, [canon.ref, canon.spec]]) : tree.shared
  parseTree({ ...tree, providers, shared })

  if (canon) writeJsonFile(sharedModelPath(root, canon.ref), canon.spec)
  writeJsonFile(join(providerDir(root, providerId), "models.json"), nextModels)
  syncManifest(root)

  if (canon) console.log(`✓ 已建共享模型 "${canon.ref}"，并让供应商 "${providerId}" 的模型 "${key}" 引用它`)
  else console.log(`✓ 已给供应商 "${providerId}" 添加模型 "${key}"`)
  console.log(`  写入 ${providerDir(root, providerId)}/models.json 与 ${join(root, "index.json")}`)
  reportReuseHint(tree, providerSpec)
}

export function commandAddSharedModel(flags) {
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

export function commandSetProvider(flags) {
  const root = resolveRoot(flags)
  rejectUnknownFlags("set-provider", flags, SET_PROVIDER_FLAGS)
  const tree = loadTree(root)
  const id = checkId(required(flags, "id", "供应商 id"), "供应商 id")
  const entry = tree.providers.find((item) => item.id === id)
  if (!entry) throw new CliError(`供应商 "${id}" 不存在（现有：${tree.providers.map((item) => item.id).join(", ")}）`)

  const unsets = parseUnsets(flags, PROVIDER_UNSET_ALIASES)
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

/** set-provider 的 `--unset` 只允许清空 baseURL（name/package 是 schema 必填）。 */
const PROVIDER_UNSET_ALIASES = new Map([["baseurl", "baseurl"], ["base-url", "baseurl"]])

const SET_MODEL_FLAGS = new Set([
  "provider", "key", "model-name", "model-id", "context", "output", "variant", "base", "input", "unset",
])

export function commandSetModel(flags) {
  const root = resolveRoot(flags)
  rejectUnknownFlags("set-model", flags, SET_MODEL_FLAGS)
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

export function commandSetSharedModel(flags) {
  const root = resolveRoot(flags)
  rejectUnknownFlags("set-shared-model", flags, SET_SHARED_FLAGS)
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

export function commandRemoveProvider(flags) {
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
  const orphans = deleteOrphanShared(root, tree.shared, providers)
  syncManifest(root)
  console.log(`✓ 已删除供应商 "${id}"（${entry.provider.name}，${Object.keys(entry.models).length} 个模型）`)
  console.log(`  删除 ${providerDir(root, id)}/ 并重写 ${join(root, "index.json")}`)
  if (orphans.length > 0) console.log(`  已自动清理无人引用的共享模型：${orphans.join(", ")}`)
}

export function commandRemoveModel(flags) {
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
  const orphans = deleteOrphanShared(root, tree.shared, providers)
  syncManifest(root)
  console.log(`✓ 已从供应商 "${providerId}" 删除模型 "${key}"`)
  console.log(`  写入 ${providerDir(root, providerId)}/models.json 与 ${join(root, "index.json")}`)
  if (orphans.length > 0) console.log(`  已自动清理无人引用的共享模型：${orphans.join(", ")}`)
}

export function commandRemoveSharedModel(flags) {
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
        `  推荐用 remove-model --provider <id> --key <key> 删掉引用方；` +
        `要保留它就 set-model --unset base 并同时补齐 name/limit —— 纯 base 引用直接 --unset base 会留下无 limit 的非法模型`,
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
