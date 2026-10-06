import assert from "node:assert/strict"
import test from "node:test"

import { loadRegistry, type RegistryCacheEntry } from "../.opencode/plugins/opencode-providers/registry/source.ts"

const VALID_BODY = JSON.stringify({
  schemaVersion: 1,
  models: {},
  providers: {
    acme: { name: "Acme", package: "@opencode/ai/providers/openai-compatible", models: { m: { limit: { context: 10, output: 1 } } } },
  },
})

function memoryStore(initial?: RegistryCacheEntry) {
  let value = initial
  const writes: RegistryCacheEntry[] = []
  return {
    writes,
    current: () => value,
    store: {
      async get() {
        return value
      },
      async set(entry: RegistryCacheEntry) {
        value = entry
        writes.push(entry)
      },
    },
  }
}

function jsonFetch(body: string, init?: ResponseInit & { readonly throw?: never }) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetch = (async (url: any, options: any) => {
    calls.push({ url: String(url), headers: options?.headers ?? {} })
    return new Response(body, { status: 200, ...init })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const NOW = 1_700_000_000_000

test("fresh cache is served without fetching", async () => {
  const cached = memoryStore({ fetchedAt: NOW - 1000, body: VALID_BODY })
  const { fetch, calls } = jsonFetch(VALID_BODY)
  const result = await loadRegistry({ store: cached.store, fetch, now: () => NOW })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.source, "cache")
  assert.equal(calls.length, 0)
})

test("expired cache triggers a network fetch and writes the cache", async () => {
  const cached = memoryStore({ fetchedAt: NOW - 10_000_000, body: VALID_BODY })
  const { fetch, calls } = jsonFetch(VALID_BODY, { headers: { etag: '"v1"' } })
  const result = await loadRegistry({ store: cached.store, fetch, now: () => NOW, ttlMs: 1000 })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.source, "network")
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.headers["if-none-match"], undefined)
  assert.deepEqual(cached.current(), { etag: '"v1"', fetchedAt: NOW, body: VALID_BODY })
})

test("conditional request sends If-None-Match and a 304 keeps the cached body", async () => {
  const cached = memoryStore({ etag: '"v1"', fetchedAt: NOW - 10_000_000, body: VALID_BODY })
  const calls: any[] = []
  const fetch = (async (url: any, options: any) => {
    calls.push(options)
    return new Response(null, { status: 304 })
  }) as unknown as typeof globalThis.fetch
  const result = await loadRegistry({ store: cached.store, fetch, now: () => NOW, ttlMs: 1000 })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.source, "cache")
  assert.equal(calls[0]?.headers["if-none-match"], '"v1"')
  assert.equal(cached.current()?.fetchedAt, NOW)
  assert.equal(cached.current()?.body, VALID_BODY)
})

test("network failure falls back to the stale cache", async () => {
  const cached = memoryStore({ fetchedAt: NOW - 10_000_000, body: VALID_BODY })
  const fetch = (async () => {
    throw new Error("offline")
  }) as unknown as typeof globalThis.fetch
  const result = await loadRegistry({ store: cached.store, fetch, now: () => NOW, ttlMs: 1000 })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.source, "stale-cache")
})

test("network failure without a cache fails", async () => {
  const cached = memoryStore()
  const fetch = (async () => {
    throw new Error("offline")
  }) as unknown as typeof globalThis.fetch
  const result = await loadRegistry({ store: cached.store, fetch, now: () => NOW })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.errors.join("\n"), /offline/)
})

test("an HTTP error falls back to the stale cache", async () => {
  const cached = memoryStore({ fetchedAt: NOW - 10_000_000, body: VALID_BODY })
  const fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof globalThis.fetch
  const result = await loadRegistry({ store: cached.store, fetch, now: () => NOW, ttlMs: 1000 })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.source, "stale-cache")
})

test("an invalid body from the network falls back to the stale cache", async () => {
  const cached = memoryStore({ fetchedAt: NOW - 10_000_000, body: VALID_BODY })
  const { fetch } = jsonFetch('{"schemaVersion":99,"providers":{}}')
  const result = await loadRegistry({ store: cached.store, fetch, now: () => NOW, ttlMs: 1000 })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.source, "stale-cache")
})

test("an invalid body with no cache reports validation errors", async () => {
  const cached = memoryStore()
  const { fetch } = jsonFetch('{"schemaVersion":99,"providers":{}}')
  const result = await loadRegistry({ store: cached.store, fetch, now: () => NOW })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.errors.join("\n"), /schemaVersion/)
})

test("non-JSON bodies are reported", async () => {
  const cached = memoryStore()
  const { fetch } = jsonFetch("not json")
  const result = await loadRegistry({ store: cached.store, fetch, now: () => NOW })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.errors.join("\n"), /not valid JSON/)
})

test("a broken store never breaks loading", async () => {
  const store = {
    async get(): Promise<RegistryCacheEntry | undefined> {
      throw new Error("kv down")
    },
    async set(): Promise<void> {
      throw new Error("kv down")
    },
  }
  const { fetch } = jsonFetch(VALID_BODY)
  const result = await loadRegistry({ store, fetch, now: () => NOW })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.source, "network")
})
