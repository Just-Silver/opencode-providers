import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"
import test from "node:test"

import { parseRegistry, resolveModelSpec, SUPPORTED_SCHEMA_VERSION } from "../.opencode/plugins/opencode-providers/registry/schema.ts"

const minimal = {
  schemaVersion: SUPPORTED_SCHEMA_VERSION,
  models: {},
  providers: {
    acme: {
      name: "Acme",
      package: "@opencode/ai/providers/openai-compatible",
      baseURL: "https://llm.acme.example/v1",
      models: {
        "acme-chat": {
          limit: { context: 1000, output: 100 },
        },
      },
    },
  },
}

test("accepts a minimal registry", () => {
  const result = parseRegistry(minimal)
  assert.equal(result.ok, true)
})

test("rejects an unsupported schemaVersion", () => {
  const result = parseRegistry({ ...minimal, schemaVersion: SUPPORTED_SCHEMA_VERSION + 1 })
  assert.equal(result.ok, false)
  assert.match(result.errors.join("\n"), /schemaVersion/)
})

test("requires limit when a model has no base", () => {
  const result = parseRegistry({
    ...minimal,
    providers: {
      acme: { ...minimal.providers.acme, models: { "acme-chat": { name: "Chat" } } },
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.errors.join("\n"), /limit: required/)
})

test("allows omitting limit when base provides it", () => {
  const result = parseRegistry({
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    models: { "shared-chat": { limit: { context: 1000, output: 100 } } },
    providers: {
      acme: {
        name: "Acme",
        package: "pkg",
        models: { "acme-chat": { base: "shared-chat" } },
      },
    },
  })
  assert.equal(result.ok, true)
})

test("rejects an unknown base reference", () => {
  const result = parseRegistry({
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    models: {},
    providers: {
      acme: { name: "Acme", package: "pkg", models: { "acme-chat": { base: "nope" } } },
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.errors.join("\n"), /unknown shared model "nope"/)
})

test("rejects non-positive limits and malformed cost", () => {
  const result = parseRegistry({
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    models: {},
    providers: {
      acme: {
        name: "Acme",
        package: "pkg",
        models: { "acme-chat": { limit: { context: 0, output: 100 }, cost: { input: 1 } } },
      },
    },
  })
  assert.equal(result.ok, false)
  const errors = result.errors.join("\n")
  assert.match(errors, /limit\.context/)
  assert.match(errors, /cost\.output/)
})

test("rejects a provider without models", () => {
  const result = parseRegistry({
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    models: {},
    providers: { acme: { name: "Acme", package: "pkg", models: {} } },
  })
  assert.equal(result.ok, false)
  assert.match(result.errors.join("\n"), /models: must be a non-empty object/)
})

test("resolveModelSpec layers provider overrides over the shared model", () => {
  const result = parseRegistry({
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    models: { shared: { name: "Shared", limit: { context: 1000, output: 100 }, cost: { input: 1, output: 2 } } },
    providers: {
      acme: { name: "Acme", package: "pkg", models: { alias: { base: "shared", limit: { context: 2000, output: 200 } } } },
    },
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const resolved = resolveModelSpec(result.registry, result.registry.providers.acme.models.alias)
  assert.equal(resolved?.name, "Shared")
  assert.deepEqual(resolved?.limit, { context: 2000, output: 200 })
  assert.deepEqual(resolved?.cost, { input: 1, output: 2 })
})

test("shipped registry.json parses", () => {
  const path = fileURLToPath(new URL("../registry.json", import.meta.url))
  const parsed = parseRegistry(JSON.parse(readFileSync(path, "utf8")))
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("\n"))
  if (parsed.ok) assert.ok(Object.keys(parsed.registry.providers).length > 0)
})
