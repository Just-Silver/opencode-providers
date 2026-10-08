import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import { buildRegistry, parseManifest } from "../plugin/opencode-providers/registry/aggregate.ts"
import { buildProviderModels } from "../plugin/opencode-providers/registry/models.ts"
import { parseRegistry } from "../plugin/opencode-providers/registry/schema.ts"
import { need, registryView } from "./helpers/shipped.ts"

/**
 * 走**随仓注册表**的端到端链路：分文件聚合 → schema → 注册用的模型装配。
 *
 * 期望值一律**从注册表本身动态推导**（不写死任何供应商 / 模型 / 共享模型），
 * 所以新增或删除供应商、模型、共享模型时这个文件不需要改一行。
 */

const root = new URL("../registry/", import.meta.url)
const rootPath = fileURLToPath(root)
const read = (rel: string): unknown => JSON.parse(readFileSync(new URL(rel, root), "utf8"))

const manifest = parseManifest(read("index.json"))
if (!manifest.ok) throw new Error(manifest.errors.join("\n"))
const built = await buildRegistry(manifest.manifest, async (rel) => read(rel))
if (!built.ok) throw new Error(built.errors.join("\n"))
const shipped = built.registry

test("随仓分文件聚合后通过 schema 校验", () => {
  const result = parseRegistry(shipped)
  assert.equal(result.ok, true, result.ok ? "" : result.errors.join("\n"))
})

test("真实供应商：每家都有 name/package，且 baseURL 不重复", () => {
  const result = parseRegistry(shipped)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const providers = result.registry.providers
  const view = registryView(rootPath)

  // manifest 列出的每一家都聚合进来了，且至少一个模型
  assert.deepEqual(Object.keys(providers).sort(), view.ids())
  for (const id of view.ids()) {
    const provider = providers[id]!
    assert.equal(provider.name, view.provider(id).name)
    assert.ok(provider.package, `${id} 应声明 package`)
    assert.ok(Object.keys(provider.models).length > 0, `${id} 应至少有一个模型`)
  }

  // baseURL 不重复（冲突是 add-provider 会拒绝的情况）
  const urls = Object.entries(providers)
    .map(([id, provider]) => [id, provider.baseURL] as const)
    .filter((pair): pair is readonly [string, string] => pair[1] !== undefined)
  assert.equal(new Set(urls.map(([, url]) => url)).size, urls.length)
})

test("真实模型：共享 base + 各自 modelID 覆盖（走注册用的 buildProviderModels）", () => {
  const result = parseRegistry(shipped)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const registry = result.registry
  const view = registryView(rootPath)

  // 每家每个模型都能装配出来，且模型总数与注册表一致
  let total = 0
  for (const id of view.ids()) {
    const models = buildProviderModels(registry, id, registry.providers[id]!)
    assert.equal(models.length, view.keys(id).length, `${id} 装配出的模型数应与注册表一致`)
    total += models.length
    for (const model of models) {
      assert.equal(model.providerID, id)
      assert.ok(model.limit && model.limit.context > 0 && model.limit.output > 0, `${id}/${model.id} 应有正数 limit`)
      assert.equal(model.capabilities.tools, true, "插件默认补 tools")
    }
  }
  assert.equal(total, view.modelCount())

  // 引用了共享 base 的模型：名字/limit 来自共享模型，各家可覆盖 modelID
  for (const { id, key, spec } of view.basedModels()) {
    const ref = need(spec.base, `${id}/${key} 的 base`)
    const sharedSpec = view.sharedSpec(ref)
    const assembled = need(
      buildProviderModels(registry, id, registry.providers[id]!).find((model) => model.id === key),
      `${id}/${key}`,
    )
    assert.equal(assembled.name, sharedSpec.name, `${id}/${key} 应继承共享模型 name`)
    assert.deepEqual(assembled.limit, sharedSpec.limit, `${id}/${key} 应继承共享模型 limit`)
    // modelID 默认等于 key，除非显式覆盖
    assert.equal(assembled.modelID, spec.modelID ?? key)
  }

  // 内联模型：不带 base，limit 原样落地
  for (const id of view.ids()) {
    for (const [key, spec] of Object.entries(view.models(id))) {
      if (spec.base !== undefined) continue
      const assembled = need(
        buildProviderModels(registry, id, registry.providers[id]!).find((model) => model.id === key),
        `${id}/${key}`,
      )
      assert.deepEqual(assembled.limit, spec.limit, `${id}/${key} 内联 limit 应原样落地`)
      assert.equal(assembled.modelID, spec.modelID ?? key)
    }
  }
})

test("随仓里被 base 引用的共享模型都存在（无悬空引用）", () => {
  const view = registryView(rootPath)
  for (const ref of view.referenced().keys()) {
    assert.ok(view.shared()[ref], `共享模型 ${ref} 被引用但不存在`)
  }

  const result = parseRegistry(shipped)
  assert.equal(result.ok, true)
  if (!result.ok) return

  // 聚合是**按需拉取**：只拉被 base 引用的共享模型；未被引用的（孤儿）不进聚合结果。
  for (const ref of view.referenced().keys()) {
    assert.ok(result.registry.models[ref], `聚合结果缺少被引用的共享模型 ${ref}`)
  }
  for (const ref of view.sharedRefs()) {
    if (view.referenced().has(ref)) continue
    assert.equal(result.registry.models[ref], undefined, `孤儿共享模型 ${ref} 不该被拉取`)
  }
})

test("随仓里没有 env/apiKey 明文凭据", () => {
  const view = registryView(rootPath)
  for (const id of view.ids()) {
    const serialized = JSON.stringify(view.provider(id))
    assert.doesNotMatch(serialized, /"env"/, `${id} 不该声明 env`)
    assert.doesNotMatch(serialized, /"apiKey"/, `${id} 不该声明 apiKey`)
    for (const [key, spec] of Object.entries(view.models(id))) {
      assert.doesNotMatch(JSON.stringify(spec), /"env"|"apiKey"/, `${id}/${key} 不该带凭据字段`)
    }
  }
})

test("随仓供应商 id 都是合法路径段（不含 / 与 :）", () => {
  const view = registryView(rootPath)
  for (const id of view.ids()) assert.match(id, /^[a-z0-9._-]+$/)
  for (const ref of view.sharedRefs()) assert.equal(ref.split("/").length, 2)
})