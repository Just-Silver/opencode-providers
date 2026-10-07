import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import plugin from "../plugin/opencode-providers/index.ts"

/**
 * 走**真的 server 入口** + **随仓注册表** + 假的插件 ctx，钉住注册链路：
 * integration.update / method.update / provider.add 的入参形状。
 * （真机上这一步还会被 `opencode.json` 里的同名 provider 盖住，见
 * docs/opencode-plugin-provider-no-config.md 的「撞名」一节，所以这里单独钉。）
 */

const registryBody = readFileSync(new URL("../registry/registry.json", import.meta.url), "utf8")

interface FakeContext {
  readonly integrations: Map<string, { id: string; name: string; metadata?: Record<string, unknown> }>
  readonly methods: Array<{ integrationID: string; method: { type: string; label?: string } }>
  readonly providers: Array<{ info: Record<string, unknown>; models: readonly Record<string, any>[] }>
  readonly storage: Map<string, unknown>
  readonly ctx: any
}

function fakeContext(options: Record<string, unknown> = {}): FakeContext {
  const state: FakeContext = {
    integrations: new Map(),
    methods: [],
    providers: [],
    storage: new Map(),
    ctx: undefined,
  }
  const storage = state.storage
  state.ctx = {
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
            state.integrations.set(id, integration)
          },
          method: {
            update: (input: { integrationID: string; method: { type: string; label?: string } }) =>
              void state.methods.push(input),
          },
        })
      },
    },
    provider: {
      transform: async (callback: (editor: any) => void) => {
        callback({ add: (input: any) => void state.providers.push(input) })
      },
    },
  }
  return state
}

async function withFetch(body: string, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(body, { status: 200, headers: { "content-type": "application/json", etag: '"test"' } })) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

test("server 入口用随仓注册表注册 integration（带 metadata.source / keyLabel / key 方法）", async () => {
  const state = fakeContext()
  await withFetch(registryBody, async () => {
    await plugin.setup(state.ctx)
  })

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
  await withFetch(registryBody, async () => {
    await plugin.setup(state.ctx)
  })

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
  const original = globalThis.fetch
  const errors = console.error
  console.error = () => {}
  globalThis.fetch = (async () => new Response("nope", { status: 404, statusText: "Not Found" })) as typeof fetch
  try {
    await plugin.setup(state.ctx)
  } finally {
    globalThis.fetch = original
    console.error = errors
  }
  assert.equal(state.integrations.size, 0)
  assert.equal(state.providers.length, 0)
})

test("缓存按 URL 隔离：命中缓存时不再打网络", async () => {
  const state = fakeContext()
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(registryBody, { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    await plugin.setup(state.ctx)
    assert.equal(calls, 1)
    await plugin.setup(state.ctx)
    assert.equal(calls, 1, "第二次应命中缓存（TTL 内）")
    assert.equal(state.storage.size, 1)
    const key = [...state.storage.keys()][0]!
    assert.match(key, /^registry-cache:https:\/\/raw\.githubusercontent\.com\//)
  } finally {
    globalThis.fetch = original
  }
})

// 配置里写成对象形式就能传 options：plugins: [{ package: "…", options: { registryUrl: "…" } }]
// （opencode 的 config.plugins 条目 schema 支持 options，见 schema/src/config/plugin.ts:6-11）
test("options.registryUrl 可换注册表地址：拉取它、且缓存键含该 URL", async () => {
  const state = fakeContext({ registryUrl: "https://registry.example.test/registry.json" })
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url))
    return new Response(registryBody, { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    await plugin.setup(state.ctx)
  } finally {
    globalThis.fetch = original
  }

  assert.deepEqual(calls, ["https://registry.example.test/registry.json"])
  assert.deepEqual([...state.storage.keys()], ["registry-cache:https://registry.example.test/registry.json"])
  assert.deepEqual([...state.integrations.keys()].sort(), ["command-code", "r4-coder"])
})
