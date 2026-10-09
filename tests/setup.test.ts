import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import plugin from "../plugin/opencode-providers/index.ts"
import { DEFAULT_REGISTRY_URL } from "../plugin/opencode-providers/registry/source.ts"
import { registryView, type ProviderSpec } from "./helpers/shipped.ts"

/**
 * 走**真的 server 入口** + **随仓分文件注册表** + 假的插件 ctx，钉住注册链路：
 * integration.update / method.update / provider.add 的入参形状，以及 RPC 强制刷新。
 * （真机上这一步还会被 `opencode.json` 里的同名 provider 盖住，见
 * docs/opencode-plugin-provider-no-config.md 的「撞名」一节，所以这里单独钉。）
 *
 * 期望值一律**从随仓注册表动态推导**（供应商 id、模型数、取数次数），所以新增供应商/模型
 * 不需要改这个测试文件——它只钉「拉到什么就注册什么」。
 */

const registryRoot = new URL("../registry/", import.meta.url)

/** 递归收集注册表目录下所有文件：相对 posix 路径 → 内容。 */
function readRegistryTree(): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: URL, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`)
      else out[`${prefix}${entry.name}`] = readFileSync(new URL(entry.name, dir), "utf8")
    }
  }
  walk(registryRoot, "")
  return out
}

const REGISTRY_TREE = readRegistryTree()

/** 注册表里全部供应商 id（按 providers/<id>/provider.json 推导，已排序）。 */
const PROVIDER_IDS: readonly string[] = Object.keys(REGISTRY_TREE)
  .filter((rel) => /^providers\/[^/]+\/provider\.json$/.test(rel))
  .map((rel) => rel.split("/")[1]!)
  .sort()

const modelsOf = (id: string): Record<string, { base?: unknown }> =>
  JSON.parse(REGISTRY_TREE[`providers/${id}/models.json`]!) as Record<string, { base?: unknown }>

const MODEL_COUNT = PROVIDER_IDS.reduce((total, id) => total + Object.keys(modelsOf(id)).length, 0)

/** loader 取数次数 = manifest(1) + 每家 provider.json/models.json(2) + 被 base 引用的共享模型。 */
const SHARED_BASES = new Set<string>()
for (const id of PROVIDER_IDS) {
  for (const spec of Object.values(modelsOf(id))) {
    if (typeof spec.base === "string" && spec.base) SHARED_BASES.add(spec.base)
  }
}
const EXPECTED_FETCHES = 1 + PROVIDER_IDS.length * 2 + SHARED_BASES.size

/** 每家的 provider.json（name / baseURL / keyLabel），期望值从随仓注册表推导。 */
const SHIPPED_PROVIDERS: Record<string, ProviderSpec> = Object.fromEntries(
  PROVIDER_IDS.map((id) => [
    id,
    JSON.parse(REGISTRY_TREE[`providers/${id}/provider.json`]!) as ProviderSpec,
  ]),
)

/** 随仓某家带 modelID 覆盖 / 只写 base 的模型（动态挑，找不到就跳过该断言）。 */
const SHIPPED_VIEW = registryView(fileURLToPath(new URL("../registry/", import.meta.url)))
const OVERRIDE_MODEL = SHIPPED_VIEW.modelWithModelIDOverride()
const BASE_ONLY_MODEL = SHIPPED_VIEW.baseOnlyModel()
const INLINE_MODEL = (() => {
  for (const id of PROVIDER_IDS) {
    for (const [key, spec] of Object.entries(SHIPPED_VIEW.models(id))) {
      if (spec.base === undefined && spec.limit !== undefined) return { id, key, spec }
    }
  }
  return undefined
})()

/** Serves a registry tree keyed by manifest-relative path; missing keys are 404. */
function treeFetch(tree: Record<string, string>, manifestUrl: string = DEFAULT_REGISTRY_URL) {
  const base = manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1)
  const calls: string[] = []
  const fetch = (async (input: any) => {
    const url = String(input)
    calls.push(url)
    const rel = url === manifestUrl ? "index.json" : url.startsWith(base) ? url.slice(base.length) : url
    if (!(rel in tree)) return new Response("not found", { status: 404, statusText: "Not Found" })
    return new Response(tree[rel], {
      status: 200,
      headers: { "content-type": "application/json", etag: `"${rel}"` },
    })
  }) as typeof fetch
  return { fetch, calls }
}

async function withFetch<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

interface FakeContext {
  readonly integrations: Map<string, { id: string; name: string; metadata?: Record<string, unknown> }>
  readonly methods: Array<{ integrationID: string; method: { type: string; label?: string } }>
  readonly providers: Array<{ info: Record<string, unknown>; models: readonly Record<string, any>[] }>
  readonly storage: Map<string, unknown>
  readonly reloads: { integration: number; provider: number }
  readonly registered: { handlers?: Record<string, (input: unknown, context: unknown) => Promise<unknown>> }
  readonly ctx: any
}

function fakeContext(options: Record<string, unknown> = {}): FakeContext {
  const integrations = new Map<string, { id: string; name: string; metadata?: Record<string, unknown> }>()
  const methods: FakeContext["methods"] = []
  const providers: FakeContext["providers"] = []
  const storage = new Map<string, unknown>()
  const reloads = { integration: 0, provider: 0 }
  const registered: FakeContext["registered"] = {}

  let integrationTransform: ((editor: any) => void) | undefined
  let providerTransform: ((editor: any) => void) | undefined
  // Mirrors the real host: reload re-applies the last transform, and `add`
  // replaces by id (the kernel's `editor.add` is a full replace).
  const integrationEditor = {
    update: (id: string, mutate: (integration: any) => void) => {
      const integration = { id, name: id }
      mutate(integration)
      integrations.set(id, integration)
    },
    method: {
      update: (input: { integrationID: string; method: { type: string; label?: string } }) =>
        void methods.push(input),
    },
  }
  const providerEditor = {
    add: (input: any) => {
      const index = providers.findIndex((entry) => entry.info.id === input.info.id)
      if (index === -1) providers.push(input)
      else providers[index] = input
    },
  }

  const ctx = {
    options,
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => void storage.set(key, value),
    },
    integration: {
      transform: async (callback: (editor: any) => void) => {
        integrationTransform = callback
        callback(integrationEditor)
      },
      reload: async () => {
        reloads.integration += 1
        integrationTransform?.(integrationEditor)
      },
    },
    provider: {
      transform: async (callback: (editor: any) => void) => {
        providerTransform = callback
        callback(providerEditor)
      },
      reload: async () => {
        reloads.provider += 1
        providerTransform?.(providerEditor)
      },
    },
    rpc: {
      register: async (_definition: unknown, handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>>) => {
        registered.handlers = handlers
        return { dispose: () => {} }
      },
    },
  }

  return { integrations, methods, providers, storage, reloads, registered, ctx }
}

test("server 入口用随仓注册表注册 integration（带 metadata.source / keyLabel / key 方法）", async () => {
  const state = fakeContext()
  await withFetch(treeFetch(REGISTRY_TREE).fetch, () => plugin.setup(state.ctx))

  assert.deepEqual([...state.integrations.keys()].sort(), PROVIDER_IDS)
  for (const id of PROVIDER_IDS) {
    const integration = state.integrations.get(id)!
    const expectedLabel = SHIPPED_PROVIDERS[id]!.keyLabel ?? "Paste API key"
    assert.equal(integration.metadata?.source, "opencode-providers")
    // keyLabel 可选：没声明的供应商回落到通用 label（CLI 写不了 keyLabel，故新供应商通常没有）
    if (SHIPPED_PROVIDERS[id]!.keyLabel === undefined) {
      assert.equal("keyLabel" in (integration.metadata ?? {}), false)
    } else {
      assert.equal(integration.metadata?.keyLabel, expectedLabel)
    }
  }

  // 方法的 label 与 provider 的 keyLabel 同源（无 keyLabel 时用通用文案）
  const byIntegration = new Map(state.methods.map((entry) => [entry.integrationID, entry.method]))
  assert.equal(byIntegration.size, PROVIDER_IDS.length)
  for (const id of PROVIDER_IDS) {
    assert.deepEqual(byIntegration.get(id), {
      type: "key",
      label: SHIPPED_PROVIDERS[id]!.keyLabel ?? "Paste API key",
    })
  }
})

test("server 入口注册 provider：activation auto + integrationID 对齐 + 注册表参数原样落地", async () => {
  const state = fakeContext()
  await withFetch(treeFetch(REGISTRY_TREE).fetch, () => plugin.setup(state.ctx))

  assert.equal(state.providers.length, PROVIDER_IDS.length)
  const providers = new Map(state.providers.map((entry) => [entry.info.id as string, entry]))

  // 逐家通用契约：注册表里的 name/package/baseURL 原样落地，凭据不由本项目管。
  for (const id of PROVIDER_IDS) {
    const entry = providers.get(id)!
    const shipped = SHIPPED_PROVIDERS[id]!
    assert.equal(entry.info.activation, "auto")
    assert.equal(entry.info.integrationID, id)
    assert.equal(entry.info.name, shipped.name)
    assert.equal(entry.info.package, shipped.package)
    assert.equal((entry.info.settings as any)?.baseURL, shipped.baseURL)
    assert.equal((entry.info.settings as any)?.apiKey, undefined, "不该带 env/apiKey")
    assert.ok(entry.models.length > 0, `${id} 应至少注册一个模型`)
    assert.equal(entry.models.length, Object.keys(SHIPPED_VIEW.models(id)).length)
    for (const model of entry.models as readonly any[]) {
      assert.equal(model.providerID, id)
      assert.ok(model.limit.context > 0 && model.limit.output > 0, `${id}/${model.id} 应有正数 limit`)
    }
  }

  // 覆盖了上游 modelID 的模型：注册时用上游真实 id，而不是 opencode 里的 key
  if (OVERRIDE_MODEL) {
    const entry = providers.get(OVERRIDE_MODEL.id)!
    const model = entry.models.find((candidate: any) => candidate.id === OVERRIDE_MODEL.key)
    assert.equal(model?.modelID, OVERRIDE_MODEL.modelID)
  }

  // 只写 base 的模型：limit 从共享模型解析出来
  if (BASE_ONLY_MODEL) {
    const entry = providers.get(BASE_ONLY_MODEL.id)!
    const shared = SHIPPED_VIEW.sharedSpec(BASE_ONLY_MODEL.ref)
    const model = entry.models.find((candidate: any) => candidate.id === BASE_ONLY_MODEL.key)
    assert.equal(model?.name, shared.name)
    assert.deepEqual(model?.limit, shared.limit)
  }

  // 内联模型：limit 原样落地
  if (INLINE_MODEL) {
    const entry = providers.get(INLINE_MODEL.id)!
    const model = entry.models.find((candidate: any) => candidate.id === INLINE_MODEL.key)
    assert.deepEqual(model?.limit, INLINE_MODEL.spec.limit)
    assert.deepEqual(
      model?.variants.map((variant: any) => variant.id),
      (INLINE_MODEL.spec.variants ?? []).map((variant) => variant.id),
    )
  }
})

test("注册表不可用时不注册任何东西，但 setup 不抛（插件仍 active）", async () => {
  const state = fakeContext()
  const errors = console.error
  console.error = () => {}
  try {
    await withFetch(treeFetch({}).fetch, () => plugin.setup(state.ctx))
  } finally {
    console.error = errors
  }
  assert.equal(state.integrations.size, 0)
  assert.equal(state.providers.length, 0)
})

test("M3：宿主没有 ctx.rpc 时 setup 仍照常注册（刷新不可用不应拖垮注册）", async () => {
  const state = fakeContext()
  delete state.ctx.rpc
  await withFetch(treeFetch(REGISTRY_TREE).fetch, () => plugin.setup(state.ctx))
  assert.deepEqual([...state.integrations.keys()].sort(), PROVIDER_IDS)
  assert.equal(state.providers.length, PROVIDER_IDS.length)
})

test(`缓存按 URL 隔离：首次 ${EXPECTED_FETCHES} 次取数，第二次命中缓存 +0`, async () => {
  const state = fakeContext()
  const { fetch, calls } = treeFetch(REGISTRY_TREE)
  await withFetch(fetch, async () => {
    await plugin.setup(state.ctx)
    assert.equal(calls.length, EXPECTED_FETCHES)
    await plugin.setup(state.ctx)
    assert.equal(calls.length, EXPECTED_FETCHES, "第二次应命中缓存（TTL 内），不再打网络")
  })
  assert.equal(state.storage.size, 1)
  const key = [...state.storage.keys()][0]!
  assert.match(key, /^registry-cache:https:\/\/raw\.githubusercontent\.com\//)
})

// 配置里写成对象形式就能传 options：plugins: [{ package: "…", options: { registryUrl: "…" } }]
// （opencode 的 config.plugins 条目 schema 支持 options，见 schema/src/config/plugin.ts:6-11）
test("options.registryUrl 可换注册表地址：拉取它、且缓存键含该 URL", async () => {
  const custom = "https://registry.example.test/registry.json"
  const state = fakeContext({ registryUrl: custom })
  const { fetch, calls } = treeFetch(REGISTRY_TREE, custom)
  await withFetch(fetch, () => plugin.setup(state.ctx))

  assert.equal(calls[0], custom)
  assert.ok(calls.every((url) => url.startsWith("https://registry.example.test/")))
  assert.deepEqual([...state.storage.keys()], [`registry-cache:${custom}`])
  assert.deepEqual([...state.integrations.keys()].sort(), PROVIDER_IDS)
})

test("rpc refresh：revision 未变 → ok:true、reload 各 1 次、只请求 manifest", async () => {
  const state = fakeContext()
  const { fetch, calls } = treeFetch(REGISTRY_TREE)
  await withFetch(fetch, async () => {
    await plugin.setup(state.ctx)
    const before = calls.length
    const result = (await state.registered.handlers!.refresh!({}, {})) as any
    assert.equal(result.ok, true)
    assert.equal(result.providers, PROVIDER_IDS.length)
    assert.equal(result.models, MODEL_COUNT)
    assert.equal(calls.length, before + 1, "revision 未变 → 只重新请求 manifest")
  })
  assert.equal(state.reloads.integration, 1)
  assert.equal(state.reloads.provider, 1)
})

test("rpc refresh：上游不可达（有缓存 → stale）→ ok:false、不动 state、不 reload（RF4）", async () => {
  const state = fakeContext()
  await withFetch(treeFetch(REGISTRY_TREE).fetch, () => plugin.setup(state.ctx))
  assert.equal(state.providers.length, PROVIDER_IDS.length)

  const offline = (async () => new Response("nope", { status: 404, statusText: "Not Found" })) as typeof fetch
  const result = (await withFetch(offline, async () =>
    state.registered.handlers!.refresh!({}, {}),
  )) as any

  assert.equal(result.ok, false)
  assert.match((result.errors ?? []).join("\n"), /refresh failed|cached/)
  assert.equal(state.reloads.integration, 0)
  assert.equal(state.reloads.provider, 0)
  assert.equal(state.providers.length, PROVIDER_IDS.length, "旧注册结果不应被清空")
})

// ── 后台定时刷新（服务端 tick）──────────────────────────────────────────────
// setup() 之后起一个定时器，每 refreshIntervalMs 做一次非 force 的 TTL 检查；
// 只有「TTL 过期 + revision 变化」才 reload。测试注入很小的间隔来驱动 tick。

/** 把注册表缓存行的 fetchedAt 拨回 0，模拟 TTL 过期（下个 tick 会走网络）。 */
function ageRegistryCache(state: FakeContext): void {
  const key = [...state.storage.keys()].find((candidate) => candidate.startsWith("registry-cache:"))
  assert.ok(key, "应先有注册表缓存行")
  const entry = state.storage.get(key!) as { fetchedAt: number }
  state.storage.set(key!, { ...entry, fetchedAt: 0 })
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("等待后台 tick 超时")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 就地推进 revision 并改掉某家 provider 的 name；模拟一次真实更新（须在 setup 之后调用）。 */
function bumpRevisionAndName(tree: Record<string, string>, id: string): void {
  const manifest = JSON.parse(tree["index.json"]!) as { revision: string }
  manifest.revision = "tick-changed-revision"
  tree["index.json"] = JSON.stringify(manifest)
  const provider = JSON.parse(tree[`providers/${id}/provider.json`]!) as { name: string }
  provider.name = `${provider.name} (tick updated)`
  tree[`providers/${id}/provider.json`] = JSON.stringify(provider)
}

test("后台 tick：TTL 过期且 revision 变化 → 重新注册（reload + 用新数据）", async () => {
  const state = fakeContext({ refreshIntervalMs: 20 })
  const id = PROVIDER_IDS[0]!
  const tree = { ...REGISTRY_TREE }
  const shippedName = (JSON.parse(tree[`providers/${id}/provider.json`]!) as { name: string }).name
  const updatedName = `${shippedName} (tick updated)`
  let cleanup: (() => void) | void
  await withFetch(treeFetch(tree).fetch, async () => {
    cleanup = await plugin.setup(state.ctx)
    bumpRevisionAndName(tree, id)
    ageRegistryCache(state)
    await waitFor(() => state.reloads.provider > 0)
  })
  if (typeof cleanup === "function") cleanup()
  assert.equal(state.reloads.provider, 1)
  assert.equal(state.reloads.integration, 1)
  const latest = [...state.providers].reverse().find((entry) => entry.info.id === id)
  assert.equal(latest?.info.name, updatedName)
})

test("后台 tick：TTL 过期但 revision 未变 → 不 reload（避免 /models 抖动）", async () => {
  const state = fakeContext({ refreshIntervalMs: 20 })
  const { fetch, calls } = treeFetch({ ...REGISTRY_TREE })
  let cleanup: (() => void) | void
  await withFetch(fetch, async () => {
    cleanup = await plugin.setup(state.ctx)
    const afterSetup = calls.length
    ageRegistryCache(state)
    // tick 至少走一次网络（重新请求 manifest）才可能 reload
    await waitFor(() => calls.length > afterSetup)
  })
  if (typeof cleanup === "function") cleanup()
  assert.equal(state.reloads.provider, 0, "revision 未变不应 reload")
  assert.equal(state.reloads.integration, 0)
})

test("后台 tick：setup 返回 cleanup，调用后定时器被清掉（不泄露）", async () => {
  const state = fakeContext({ refreshIntervalMs: 20 })
  const tree = { ...REGISTRY_TREE }
  const { fetch, calls } = treeFetch(tree)
  let cleanup: (() => void) | void
  await withFetch(fetch, async () => {
    cleanup = await plugin.setup(state.ctx)
    assert.equal(typeof cleanup, "function", "setup 应返回 cleanup 函数")
    if (typeof cleanup === "function") cleanup()
    bumpRevisionAndName(tree, PROVIDER_IDS[0]!)
    ageRegistryCache(state)
    const callsAfterCleanup = calls.length
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(calls.length, callsAfterCleanup, "cleanup 后不应再有 tick 请求")
    assert.equal(state.reloads.provider, 0)
  })
})