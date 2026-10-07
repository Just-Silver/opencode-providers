import assert from "node:assert/strict"
import test from "node:test"

import { loadRegistry, type RegistryCacheEntry } from "../plugin/opencode-providers/registry/source.ts"

const BASE = "https://raw.example/registry/"
const MANIFEST_URL = `${BASE}index.json`
const NOW = 1_700_000_000_000
const TTL = 1000

const REV1 = "sha256:rev1"
const REV2 = "sha256:rev2"

const acmeProvider = { name: "Acme", package: "pkg" }
const acmeModels = { m: { limit: { context: 10, output: 1 } } }
const BODY1 = JSON.stringify({ schemaVersion: 1, models: {}, providers: { acme: { ...acmeProvider, models: acmeModels } } })

interface Fixture {
  provider: unknown
  models: unknown
}

function filesFor(revision: string, providers: Record<string, Fixture>, shared: Record<string, unknown> = {}) {
  const files: Record<string, unknown> = {
    "index.json": { schemaVersion: 1, revision, providers: Object.keys(providers) },
  }
  for (const [id, fixture] of Object.entries(providers)) {
    files[`providers/${id}/provider.json`] = fixture.provider
    files[`providers/${id}/models.json`] = fixture.models
  }
  for (const [base, model] of Object.entries(shared)) files[`models/${base}.json`] = model
  return files
}

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

/** Serves `files` by registry-relative path; missing keys are 404. */
function registryFetch(files: Record<string, unknown>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetch = (async (input: any, options: any) => {
    const url = String(input)
    calls.push({ url, headers: (options?.headers ?? {}) as Record<string, string> })
    const rel = url.startsWith(BASE) ? url.slice(BASE.length) : url
    if (!(rel in files)) return new Response("not found", { status: 404, statusText: "Not Found" })
    const value = files[rel]
    return new Response(typeof value === "string" ? value : JSON.stringify(value), {
      status: 200,
      headers: { etag: `"${rel}"`, "content-type": "application/json" },
    })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

test("① 新鲜缓存不打网络", async () => {
  const cache = memoryStore({ etag: '"v1"', revision: REV1, fetchedAt: NOW - 500, body: BODY1 })
  const { fetch, calls } = registryFetch({})
  const result = await loadRegistry({ store: cache.store, fetch, url: MANIFEST_URL, now: () => NOW, ttlMs: TTL })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.source, "cache")
    assert.deepEqual(result.warnings, [])
  }
  assert.equal(calls.length, 0)
})

test("② force 绕过 TTL；revision 未变则短路为 cache（仅 1 次请求）", async () => {
  const cache = memoryStore({ revision: REV1, fetchedAt: NOW - 1000, body: BODY1 })
  const { fetch, calls } = registryFetch(filesFor(REV1, { acme: { provider: acmeProvider, models: acmeModels } }))
  const result = await loadRegistry({ store: cache.store, fetch, url: MANIFEST_URL, now: () => NOW, ttlMs: TTL, force: true })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.source, "cache")
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, MANIFEST_URL)
})

test("③ manifest 带 If-None-Match；304 + 合法缓存 → 保留 body、只刷 fetchedAt", async () => {
  const cache = memoryStore({ etag: '"v1"', revision: REV1, fetchedAt: NOW - 10_000_000, body: BODY1 })
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetch = (async (input: any, options: any) => {
    calls.push({ url: String(input), headers: options?.headers ?? {} })
    return new Response(null, { status: 304 })
  }) as unknown as typeof globalThis.fetch
  const result = await loadRegistry({ store: cache.store, fetch, url: MANIFEST_URL, now: () => NOW, ttlMs: TTL })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.source, "cache")
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.headers["if-none-match"], '"v1"')
  assert.equal(cache.current()?.fetchedAt, NOW)
  assert.equal(cache.current()?.body, BODY1)
  assert.equal(cache.current()?.revision, REV1)
})

test("④ revision 未变 → 不重拉子文件", async () => {
  const cache = memoryStore({ etag: '"v1"', revision: REV1, fetchedAt: NOW - 10_000_000, body: BODY1 })
  const { fetch, calls } = registryFetch(filesFor(REV1, { acme: { provider: acmeProvider, models: acmeModels } }))
  const result = await loadRegistry({ store: cache.store, fetch, url: MANIFEST_URL, now: () => NOW, ttlMs: TTL })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.source, "cache")
  assert.equal(calls.length, 1)
})

test("⑤ revision 变化 → 重拉子文件并写缓存（含新家）", async () => {
  const cache = memoryStore({ etag: '"v1"', revision: REV1, fetchedAt: NOW - 10_000_000, body: BODY1 })
  const files = filesFor(REV2, {
    acme: { provider: acmeProvider, models: acmeModels },
    beta: { provider: { name: "Beta", package: "pkg" }, models: { m: { limit: { context: 5, output: 1 } } } },
  })
  const { fetch, calls } = registryFetch(files)
  const result = await loadRegistry({ store: cache.store, fetch, url: MANIFEST_URL, now: () => NOW, ttlMs: TTL })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.source, "network")
  assert.ok(calls.length >= 4, `expected child fetches, got ${calls.length}`)
  const written = cache.current()
  assert.equal(written?.revision, REV2)
  assert.equal(written?.fetchedAt, NOW)
  const body = JSON.parse(written?.body ?? "{}")
  assert.ok(body.providers.beta, "新家应在写回的聚合体里")
})

test("⑥ 网络失败回退 stale", async () => {
  const cache = memoryStore({ revision: REV1, fetchedAt: NOW - 10_000_000, body: BODY1 })
  const fetch = (async () => {
    throw new Error("offline")
  }) as unknown as typeof globalThis.fetch
  const result = await loadRegistry({ store: cache.store, fetch, url: MANIFEST_URL, now: () => NOW, ttlMs: TTL })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.source, "stale-cache")
})

test("⑦ 304 且缓存 body 损坏 → 无条件 GET 后重建（RF2）", async () => {
  const cache = memoryStore({ etag: '"v1"', revision: REV1, fetchedAt: NOW - 10_000_000, body: "{ broken" })
  const files = filesFor(REV1, { acme: { provider: acmeProvider, models: acmeModels } })
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetch = (async (input: any, options: any) => {
    const url = String(input)
    calls.push({ url, headers: options?.headers ?? {} })
    if (calls.length === 1) return new Response(null, { status: 304 })
    const rel = url.slice(BASE.length)
    return new Response(JSON.stringify(files[rel]), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  const result = await loadRegistry({ store: cache.store, fetch, url: MANIFEST_URL, now: () => NOW, ttlMs: TTL })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.source, "network")
  assert.equal(calls[0]?.headers["if-none-match"], '"v1"')
  assert.equal(calls[1]?.url, MANIFEST_URL)
  assert.equal(calls[1]?.headers["if-none-match"], undefined)
  assert.ok(calls.length > 2, "损坏缓存必须触发子文件重拉")
  assert.equal(cache.current()?.revision, REV1)
})

test("⑧ 子文件 404 → 跳过该家、其余成功、warnings 非空（RF3）", async () => {
  const files = filesFor(REV1, {
    acme: { provider: acmeProvider, models: acmeModels },
    ghost: { provider: { name: "Ghost", package: "pkg" }, models: { m: { limit: { context: 5, output: 1 } } } },
  })
  delete files["providers/ghost/models.json"]
  const cache = memoryStore()
  const { fetch } = registryFetch(files)
  const result = await loadRegistry({ store: cache.store, fetch, url: MANIFEST_URL, now: () => NOW })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.source, "network")
    assert.ok(result.warnings.length > 0, "应有跳过 ghost 的 warning")
    assert.ok(Object.keys(result.registry.providers).includes("acme"))
    assert.ok(!Object.keys(result.registry.providers).includes("ghost"))
  }
})

test("⑨ 200 且 revision 未变、但缓存 body 损坏 → 重建（RF2 另一路）", async () => {
  const cache = memoryStore({ revision: REV1, fetchedAt: NOW - 10_000_000, body: "{ broken" })
  const files = filesFor(REV1, { acme: { provider: acmeProvider, models: acmeModels } })
  const { fetch, calls } = registryFetch(files)
  const result = await loadRegistry({ store: cache.store, fetch, url: MANIFEST_URL, now: () => NOW, ttlMs: TTL })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.source, "network")
  assert.ok(calls.length > 1, "应重拉子文件")
  const body = JSON.parse(cache.current()?.body ?? "{}")
  assert.ok(body.providers.acme, "写回的 cache body 必须合法")
})

test("⑩ 写缓存带 revision == manifest.revision", async () => {
  const cache = memoryStore()
  const { fetch } = registryFetch(filesFor(REV2, { acme: { provider: acmeProvider, models: acmeModels } }))
  const result = await loadRegistry({ store: cache.store, fetch, url: MANIFEST_URL, now: () => NOW })
  assert.equal(result.ok, true)
  assert.equal(cache.current()?.revision, REV2)
})

test("⑪ 无缓存且网络失败 → ok:false", async () => {
  const cache = memoryStore()
  const fetch = (async () => {
    throw new Error("offline")
  }) as unknown as typeof globalThis.fetch
  const result = await loadRegistry({ store: cache.store, fetch, url: MANIFEST_URL, now: () => NOW })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.errors.join("\n"), /offline/)
})

test("⑫ manifest 非 JSON 且无缓存 → ok:false", async () => {
  const cache = memoryStore()
  const { fetch } = registryFetch({ "index.json": "not json" })
  const result = await loadRegistry({ store: cache.store, fetch, url: MANIFEST_URL, now: () => NOW })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.errors.join("\n"), /not valid JSON/)
})

test("⑬ store 损坏不致命", async () => {
  const store = {
    async get(): Promise<RegistryCacheEntry | undefined> {
      throw new Error("kv down")
    },
    async set(): Promise<void> {
      throw new Error("kv down")
    },
  }
  const { fetch } = registryFetch(filesFor(REV1, { acme: { provider: acmeProvider, models: acmeModels } }))
  const result = await loadRegistry({ store, fetch, url: MANIFEST_URL, now: () => NOW })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.source, "network")
})

test("⑭ manifest 返回 500 且有合法缓存 → stale-cache（评审 M5）", async () => {
  const cache = memoryStore({ revision: REV1, fetchedAt: NOW - 10_000_000, body: BODY1 })
  const fetch = (async () =>
    new Response("boom", { status: 500, statusText: "Server Error" })) as unknown as typeof globalThis.fetch
  const result = await loadRegistry({ store: cache.store, fetch, url: MANIFEST_URL, now: () => NOW, ttlMs: TTL })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.source, "stale-cache")
})