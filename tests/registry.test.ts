import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { buildRegistry, parseManifest } from "../plugin/opencode-providers/registry/aggregate.ts"
import { buildProviderModels } from "../plugin/opencode-providers/registry/models.ts"
import { parseRegistry } from "../plugin/opencode-providers/registry/schema.ts"

const root = new URL("../registry/", import.meta.url)
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

test("真实供应商：command-code / r4-coder 都在，且 keyLabel 各自不同", () => {
  const result = parseRegistry(shipped)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const providers = result.registry.providers
  assert.ok(providers["command-code"], "缺少 command-code")
  assert.ok(providers["r4-coder"], "缺少 r4-coder")
  assert.equal(providers["command-code"]!.baseURL, "https://api.commandcode.ai/provider/v1")
  assert.equal(providers["r4-coder"]!.baseURL, "https://api.r4.codes/v1")
  assert.match(providers["command-code"]!.keyLabel ?? "", /Command Code/)
  assert.match(providers["r4-coder"]!.keyLabel ?? "", /R4 Coder/)
})

test("真实模型：共享 base + 各自 modelID 覆盖（走注册用的 buildProviderModels）", () => {
  const result = parseRegistry(shipped)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const registry = result.registry

  const commandCode = buildProviderModels(registry, "command-code", registry.providers["command-code"]!)
  const r4 = buildProviderModels(registry, "r4-coder", registry.providers["r4-coder"]!)
  assert.equal(commandCode.length, 1)
  assert.ok(r4.length >= 1)

  const cc = commandCode[0]!
  const r4m = r4.find((model) => model.id === "deepseek-v4.1-flash")!
  for (const model of [cc, r4m]) {
    assert.equal(model.id, "deepseek-v4.1-flash")
    assert.equal(model.name, "Deepseek V4.1 Flash")
    assert.deepEqual(model.limit, { context: 1048576, output: 393216 })
    assert.deepEqual(
      model.variants.map((variant) => variant.id),
      ["low", "high", "max"],
    )
    assert.equal(model.variants[2]?.settings?.reasoningEffort, "max")
    assert.equal(model.capabilities.tools, true)
  }
  // command-code 覆盖了发往上游的真实 id；r4-coder 用默认（= map key）
  assert.equal(cc.modelID, "deepseek/deepseek-v4.1-flash")
  assert.equal(r4m.modelID, "deepseek-v4.1-flash")

  // r4-coder 另有内联模型：内联 limit 原样落地，且不带共享 base
  const kimi = r4.find((model) => model.id === "kimi-k3")
  if (kimi) {
    assert.equal(kimi.name, "Kimi K3")
    assert.equal(kimi.modelID, "kimi-k3")
    assert.deepEqual(kimi.limit, { context: 1048576, output: 131072 })
  }
})