import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import plugin from "../plugin/opencode-providers/index.ts"
import { DEFAULT_REGISTRY_URL } from "../plugin/opencode-providers/registry/source.ts"

/**
 * 走**真的 server 入口** + **随仓分文件注册表** + 假的插件 ctx，钉住注册链路：
 * integration.update / method.update / provider.add 的入参形状，以及 RPC 强制刷新。
 * （真机上这一步还会被 `opencode.json` 里的同名 provider 盖住，见
 * docs/opencode-plugin-provider-no-config.md 的「撞名」一节，所以这里单独钉。）
 */

const registryRoot = new URL("../registry/", import.meta.url)
const readReg = (rel: string) => readFileSync(new URL(rel, registryRoot), "utf8")

const REGISTRY_TREE: Record<string, string> = {
  "index.json": readReg("index.json"),
  "providers/command-code/provider.json": readReg("providers/command-code/provider.json"),
  "providers/command-code/models.json": readReg("providers/command-code/models.json"),
  "providers/r4-coder/provider.json": readReg("providers/r4-coder/provider.json"),
  "providers/r4-coder/models.json": readReg("providers/r4-coder/models.json"),
  "models/deepseek/deepseek-v4.1-flash.json": readReg("models/deepseek/deepseek-v4.1-flash.json"),
}

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

  const ctx = {
    options,
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => void storage.set(key, value),
    },
    integration: {
      transform: async (callback: (editor: any) => void) => {
        callback({
          update: (id: string, mutate: (integration: any) => void) => {
            const integration = { id, name: id }
            mutate(integration)
            integrations.set(id, integration)
          },
          method: {
            update: (input: { integrationID: string; method: { type: string; label?: string } }) =>
              void methods.push(input),
          },
        })
      },
      reload: async () => void (reloads.integration += 1),
    },
    provider: {
      transform: async (callback: (editor: any) => void) => {
        callback({ add: (input: any) => void providers.push(input) })
      },
      reload: async () => void (reloads.provider += 1),
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

  assert.deepEqual([...state.integrations.keys()].sort(), ["command-code", "r4-coder"])
  const commandCode = state.integrations.get("command-code")!
  assert.equal(commandCode.name, "Command Code")
  assert.equal(commandCode.metadata?.source, "opencode-providers")
  assert.equal(commandCode.metadata?.keyLabel, "Paste Command Code API key")

  const byIntegration = new Map(state.methods.map((entry) => [entry.integrationID, entry.method]))
  assert.deepEqual(byIntegration.get("command-code"), { type: "key", label: "Paste Command Code API key" })
  assert.deepEqual(byIntegration.get("r4-coder"), { type: "key", label: "Paste R4 Coder API key" })
})

test("server 入口注册 provider：activation auto + integrationID 对齐 + 注册表参数原样落地", async () => {
  const state = fakeContext()
  await withFetch(treeFetch(REGISTRY_TREE).fetch, () => plugin.setup(state.ctx))

  assert.equal(state.providers.length, 2)
  const providers = new Map(state.providers.map((entry) => [entry.info.id as string, entry]))

  const commandCode = providers.get("command-code")!
  assert.equal(commandCode.info.activation, "auto")
  assert.equal(commandCode.info.integrationID, "command-code")
  assert.equal(commandCode.info.package, "@opencode/ai/providers/openai-compatible")
  assert.equal((commandCode.info.settings as any).baseURL, "https://api.commandcode.ai/provider/v1")
  assert.equal(commandCode.info.settings && (commandCode.info.settings as any).apiKey, undefined, "不该带 env/apiKey")

  const model = commandCode.models[0]!
  assert.equal(model.id, "deepseek-v4.1-flash")
  assert.equal(model.modelID, "deepseek/deepseek-v4.1-flash")
  assert.equal(model.providerID, "command-code")
  assert.deepEqual(model.limit, { context: 1048576, output: 393216 })
  assert.deepEqual(
    model.variants.map((variant: any) => variant.id),
    ["low", "high", "max"],
  )

  const r4 = providers.get("r4-coder")!
  assert.equal((r4.info.settings as any).baseURL, "https://api.r4.codes/v1")
  assert.equal(r4.models[0]!.modelID, "deepseek-v4.1-flash")
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

test("缓存按 URL 隔离：首次 6 次取数（manifest + 2 家 + 共享），第二次命中缓存 +0", async () => {
  const state = fakeContext()
  const { fetch, calls } = treeFetch(REGISTRY_TREE)
  await withFetch(fetch, async () => {
    await plugin.setup(state.ctx)
    assert.equal(calls.length, 6)
    await plugin.setup(state.ctx)
    assert.equal(calls.length, 6, "第二次应命中缓存（TTL 内），不再打网络")
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
  assert.deepEqual([...state.integrations.keys()].sort(), ["command-code", "r4-coder"])
})

test("rpc refresh：revision 未变 → ok:true、reload 各 1 次、只请求 manifest", async () => {
  const state = fakeContext()
  const { fetch, calls } = treeFetch(REGISTRY_TREE)
  await withFetch(fetch, async () => {
    await plugin.setup(state.ctx)
    const before = calls.length
    const result = (await state.registered.handlers!.refresh!({}, {})) as any
    assert.equal(result.ok, true)
    assert.equal(result.providers, 2)
    assert.equal(result.models, 2)
    assert.equal(calls.length, before + 1, "revision 未变 → 只重新请求 manifest")
  })
  assert.equal(state.reloads.integration, 1)
  assert.equal(state.reloads.provider, 1)
})

test("rpc refresh：上游不可达（有缓存 → stale）→ ok:false、不动 state、不 reload（RF4）", async () => {
  const state = fakeContext()
  await withFetch(treeFetch(REGISTRY_TREE).fetch, () => plugin.setup(state.ctx))
  assert.equal(state.providers.length, 2)

  const offline = (async () => new Response("nope", { status: 404, statusText: "Not Found" })) as typeof fetch
  const result = (await withFetch(offline, async () =>
    state.registered.handlers!.refresh!({}, {}),
  )) as any

  assert.equal(result.ok, false)
  assert.match((result.errors ?? []).join("\n"), /refresh failed|cached/)
  assert.equal(state.reloads.integration, 0)
  assert.equal(state.reloads.provider, 0)
  assert.equal(state.providers.length, 2, "旧注册结果不应被清空")
})