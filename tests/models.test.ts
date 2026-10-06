import assert from "node:assert/strict"
import test from "node:test"

import { parseRegistry } from "../.opencode/plugins/opencode-providers/registry/schema.ts"
import { buildProviderModels, buildProviderSettings } from "../.opencode/plugins/opencode-providers/registry/models.ts"

function registry() {
  const parsed = parseRegistry({
    schemaVersion: 1,
    models: {
      "shared-chat": {
        name: "Shared Chat",
        family: "shared",
        releaseDate: "2026-01-02",
        limit: { context: 1000, output: 100 },
        cost: { input: 1, output: 2, cache_read: 0.5 },
        tools: false,
        input: ["text", "image"],
        variants: [{ id: "low" }, { id: "high", settings: { reasoningEffort: "high" } }],
        reasoningField: "reasoning_content",
        maxTokensField: "max_tokens",
      },
    },
    providers: {
      acme: {
        name: "Acme",
        package: "@opencode/ai/providers/openai-compatible",
        baseURL: "https://llm.acme.example/v1",
        settings: { timeout: 1000 },
        headers: { "x-tenant": "eng" },
        models: {
          "acme-chat": { base: "shared-chat" },
          "acme-chat-v2": {
            base: "shared-chat",
            modelID: "upstream-chat-v2",
            name: "Acme Chat v2",
            cost: { input: 3, output: 4 },
          },
        },
      },
    },
  })
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("\n"))
  if (!parsed.ok) throw new Error("unreachable")
  return parsed.registry
}

test("buildProviderModels maps shared facts and provider overrides", () => {
  const r = registry()
  const models = buildProviderModels(r, "acme", r.providers.acme)
  assert.equal(models.length, 2)

  const first = models.find((model) => model.id === "acme-chat")
  assert.ok(first)
  assert.equal(first.modelID, "acme-chat")
  assert.equal(first.providerID, "acme")
  assert.equal(first.name, "Shared Chat")
  assert.equal(first.family, "shared")
  assert.equal(first.status, "active")
  assert.equal(first.enabled, true)
  assert.deepEqual(first.limit, { context: 1000, output: 100 })
  assert.deepEqual(first.capabilities, { tools: false, input: ["text", "image"], output: ["text"] })
  assert.deepEqual(first.time, { released: Date.parse("2026-01-02") })
  assert.deepEqual(first.cost, [{ input: 1, output: 2, cache: { read: 0.5, write: 0 } }])
  assert.deepEqual(first.variants, [{ id: "low" }, { id: "high", settings: { reasoningEffort: "high" } }])
  assert.deepEqual(first.compatibility, { reasoningField: "reasoning_content", maxTokensField: "max_tokens" })

  const second = models.find((model) => model.id === "acme-chat-v2")
  assert.ok(second)
  assert.equal(second.modelID, "upstream-chat-v2")
  assert.equal(second.name, "Acme Chat v2")
  assert.deepEqual(second.cost, [{ input: 3, output: 4, cache: { read: 0, write: 0 } }])
})

test("buildProviderModels defaults tools to true and modality to text", () => {
  const parsed = parseRegistry({
    schemaVersion: 1,
    models: {},
    providers: {
      acme: { name: "Acme", package: "pkg", models: { m: { limit: { context: 10, output: 1 } } } },
    },
  })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const [model] = buildProviderModels(parsed.registry, "acme", parsed.registry.providers.acme)
  assert.ok(model)
  assert.deepEqual(model.capabilities, { tools: true, input: ["text"], output: ["text"] })
  assert.deepEqual(model.cost, [])
  assert.deepEqual(model.variants, [])
  assert.equal(model.time.released, 0)
  assert.equal(model.compatibility, undefined)
})

test("buildProviderModels honours disabled", () => {
  const parsed = parseRegistry({
    schemaVersion: 1,
    models: {},
    providers: {
      acme: { name: "Acme", package: "pkg", models: { m: { limit: { context: 10, output: 1 }, disabled: true } } },
    },
  })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const [model] = buildProviderModels(parsed.registry, "acme", parsed.registry.providers.acme)
  assert.equal(model?.enabled, false)
})

test("buildProviderSettings merges baseURL with settings", () => {
  const r = registry()
  assert.deepEqual(buildProviderSettings(r.providers.acme), {
    baseURL: "https://llm.acme.example/v1",
    timeout: 1000,
  })
  assert.equal(buildProviderSettings({ name: "x", package: "pkg", models: {} }), undefined)
})
