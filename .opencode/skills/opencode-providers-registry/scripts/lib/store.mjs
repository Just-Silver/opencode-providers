/**
 * 注册表目录树读写：路径、文件 IO、revision / manifest、整树装载与组装。
 *
 * 目录形状：
 *   <root>/index.json                  # manifest（CLI 自动维护，人手不碰）
 *   <root>/providers/<id>/provider.json
 *   <root>/providers/<id>/models.json
 *   <root>/models/<lab>/<model>.json   # 顶层共享模型
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { SUPPORTED_SCHEMA_VERSION, parseRegistry } from "../../../../../plugin/opencode-providers/registry/schema.ts"
import { CliError, checkBaseRef, isPlainObject, lastOf } from "./cli.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))

/** 默认注册表根：`<repo>/registry`（lib → scripts → skill → skills → .opencode → repo）。 */
export const DEFAULT_ROOT = resolve(HERE, "../../../../../registry")

export function resolveRoot(flags) {
  const override = lastOf(flags, "root")
  if (typeof override === "string" && override.trim() !== "") return resolve(process.cwd(), override)
  return DEFAULT_ROOT
}

export const providerDir = (root, id) => join(root, "providers", id)
export const sharedModelPath = (root, ref) => join(root, "models", ...ref.split("/")) + ".json"

export function readJsonFile(path) {
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
export function writeJsonFile(path, value) {
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

export function providerDirs(root) {
  const dir = join(root, "providers")
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/** `revision` = providers/** 与 models/** 全部文件按相对路径排序后的确定性哈希。 */
export function computeRevision(root) {
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
export function syncManifest(root) {
  const providers = providerDirs(root)
  const revision = computeRevision(root)
  writeJsonFile(join(root, "index.json"), { schemaVersion: SUPPORTED_SCHEMA_VERSION, revision, providers })
  return { providers, revision }
}

/** 把整棵树读进内存（用于校验与只读命令）。 */
export function loadTree(root) {
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

/** 把分文件树组装成 `parseRegistry` 吃的单一对象。 */
export function assemble(tree) {
  const models = {}
  for (const [ref, model] of tree.shared) models[ref] = model
  const providers = {}
  for (const entry of tree.providers) providers[entry.id] = { ...entry.provider, models: entry.models }
  return { schemaVersion: SUPPORTED_SCHEMA_VERSION, models, providers }
}

/** 组装 + 校验；失败抛 CliError（写命令在落盘前调用它）。 */
export function parseTree(tree) {
  const result = parseRegistry(assemble(tree))
  if (!result.ok) throw new CliError(`注册表未通过 schema 校验：\n- ${result.errors.join("\n- ")}`)
  return result.registry
}

export function requireShared(tree, base) {
  checkBaseRef(base)
  if (!tree.shared.has(base)) {
    throw new CliError(`--base "${base}" 不在共享模型里（现有：${[...tree.shared.keys()].join(", ") || "无"}）`)
  }
  return base
}
