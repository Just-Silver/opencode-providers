import assert from "node:assert/strict"
import test from "node:test"

import { buildRegistry, parseManifest } from "../plugin/opencode-providers/registry/aggregate.ts"

const manifest = { schemaVersion: 1, revision: "sha256:r1", providers: ["acme", "broken"] }
const reader =
  (files: Record<string, unknown>) =>
  async (path: string): Promise<unknown> => {
    if (!(path in files)) throw new Error(`404 ${path}`)
    return files[path]
  }

test("parseManifest 接受合法、拒绝非法", () => {
  assert.equal(parseManifest(manifest).ok, true)
  assert.equal(parseManifest({ schemaVersion: 2, revision: "x", providers: [] }).ok, false)
  assert.equal(parseManifest({ schemaVersion: 1, revision: "", providers: [] }).ok, false)
  assert.equal(parseManifest({ schemaVersion: 1, revision: "x", providers: [1] }).ok, false)
})

test("buildRegistry 组装 + 按需拉 base，坏家跳过", async () => {
  const files = {
    "providers/acme/provider.json": { name: "Acme", package: "pkg", baseURL: "https://acme.example/v1" },
    "providers/acme/models.json": { m: { base: "deepseek/deepseek-v4.1-flash" } },
    "models/deepseek/deepseek-v4.1-flash.json": { limit: { context: 10, output: 2 } },
    "providers/broken/provider.json": { name: "Broken", package: "pkg" },
    "providers/broken/models.json": { m: { base: "missing/model" } },
  }
  const result = await buildRegistry(manifest, reader(files))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(Object.keys(result.registry.providers), ["acme"])
  assert.ok(result.warnings.some((w) => w.includes("broken")))
  assert.deepEqual(Object.keys(result.registry.models), ["deepseek/deepseek-v4.1-flash"])
})

test("字段非法的一家（内联模型缺 limit）被跳过，其余照常（RF1）", async () => {
  const files = {
    "providers/acme/provider.json": { name: "Acme", package: "pkg" },
    "providers/acme/models.json": { m: { limit: { context: 10, output: 2 } } },
    "providers/bad/provider.json": { name: "Bad", package: "pkg" },
    "providers/bad/models.json": { m: { name: "no-limit-no-base" } },
  }
  const result = await buildRegistry(manifest, reader(files))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(Object.keys(result.registry.providers), ["acme"])
})

test("全坏 → ok:false", async () => {
  const result = await buildRegistry({ ...manifest, providers: ["broken"] }, reader({}))
  assert.equal(result.ok, false)
})