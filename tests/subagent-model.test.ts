import assert from "node:assert/strict"
import { test } from "node:test"

import { registerSubagentModelPolicy } from "../plugin/opencode-providers/subagent-model.ts"

const POLICY_KEY = "subagent-model-policy"

interface ModelInfo {
  readonly id: string
  readonly providerID: string
  readonly type?: string
  readonly variants?: readonly { readonly id: string }[]
}

interface FakeStorage {
  readonly map: Map<string, unknown>
  failGet: boolean
  failSet: boolean
  readonly api: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
  }
}

function fakeStorage(initial?: Record<string, unknown>): FakeStorage {
  const map = new Map<string, unknown>(Object.entries(initial ?? {}))
  const state: FakeStorage = {
    map,
    failGet: false,
    failSet: false,
    api: {
      async get(key) {
        if (state.failGet) throw new Error("storage unavailable")
        return map.get(key)
      },
      async set(key, value) {
        if (state.failSet) throw new Error("storage unavailable")
        map.set(key, value)
      },
    },
  }
  return state
}

const enabledPolicy = (model: string): Record<string, unknown> => ({ [POLICY_KEY]: { model } })

const MODEL_A: ModelInfo = {
  id: "model-a",
  providerID: "provider-a",
  type: "chat",
  variants: [{ id: "high" }, { id: "low" }],
}

const SLASH_MODEL: ModelInfo = {
  id: "model/img",
  providerID: "provider-a",
  type: "chat",
  variants: [{ id: "high" }],
}

const IMAGE_MODEL: ModelInfo = { id: "vision", providerID: "provider-a", type: "image" }

const CATALOG: readonly ModelInfo[] = [MODEL_A, SLASH_MODEL, IMAGE_MODEL]

interface FakeHost {
  readonly hook?: (event: { tool: string; input: unknown }) => Promise<void>
}

interface HostOptions {
  readonly storage: FakeStorage
  /** `"none"` = 宿主没有模型目录能力（旧宿主）。 */
  readonly models?: readonly ModelInfo[] | "none"
  readonly hook?: boolean
  readonly hookError?: Error
}

async function register(options: HostOptions) {
  const host: { hook?: (event: { tool: string; input: unknown }) => Promise<void> } = {}
  const ctx: Record<string, unknown> = { storage: options.storage.api }

  if (options.hook !== false) {
    ctx.tool = {
      hook: async (name: string, callback: (event: { tool: string; input: unknown }) => Promise<void>) => {
        assert.equal(name, "execute.before")
        if (options.hookError !== undefined) throw options.hookError
        host.hook = callback
        return { dispose: async () => {} }
      },
    }
  }

  if (options.models !== "none") {
    const catalog = options.models ?? []
    ctx.model = {
      list: async (query?: { types?: readonly string[] }) => {
        const types = query?.types
        const data =
          types === undefined ? catalog : catalog.filter((model) => types.includes(model.type ?? "chat"))
        return { location: {}, data }
      },
    }
  }

  const handlers = await registerSubagentModelPolicy(ctx as never)
  return { host: host as FakeHost, handlers }
}

async function intercept(
  host: FakeHost,
  input: unknown,
  tool = "subagent",
): Promise<{ tool: string; input: any }> {
  assert.equal(typeof host.hook, "function", "执行前钩子应已注册")
  const event = { tool, input }
  await host.hook!(event)
  return event
}

const subagentInput = (extra: Record<string, unknown> = {}) => ({
  agent: "general",
  description: "短标签",
  prompt: "做点事",
  ...extra,
})

test("未设置策略时 subagent 输入原样保留（不给缺省值补 model）", async () => {
  const { host, handlers } = await register({ storage: fakeStorage(), models: CATALOG })

  const bare = subagentInput()
  assert.deepEqual((await intercept(host, bare)).input, bare)

  const explicit = subagentInput({ model: "provider-a/model-a" })
  assert.deepEqual((await intercept(host, explicit)).input, explicit)

  const current = await handlers.getSubagentModel({})
  assert.equal(current.ok, true)
  assert.equal(current.supported, true)
  assert.equal(current.model, null)
})

test("策略只作用于 subagent 的有效对象输入", async () => {
  const { host } = await register({
    storage: fakeStorage(enabledPolicy("provider-a/model-a#high")),
    models: CATALOG,
  })

  const bashInput = { command: "echo hi" }
  assert.deepEqual((await intercept(host, bashInput, "bash")).input, bashInput)

  assert.equal((await intercept(host, "not-an-object")).input, "not-an-object")
  assert.equal((await intercept(host, null)).input, null)
  assert.deepEqual((await intercept(host, ["array"])).input, ["array"])
})

test("启用后未显式指定 model 的调用也被覆盖，其他字段与续接/后台参数保留", async () => {
  const { host } = await register({
    storage: fakeStorage(enabledPolicy("provider-a/model-a#high")),
    models: CATALOG,
  })

  const input = subagentInput({ sessionID: "ses_child", background: true })
  const event = await intercept(host, input)

  assert.deepEqual(event.input, { ...input, model: "provider-a/model-a#high" })
})

test("启用后显式指定的 model 同样被覆盖", async () => {
  const { host } = await register({
    storage: fakeStorage(enabledPolicy("provider-a/model-a")),
    models: CATALOG,
  })

  const event = await intercept(host, subagentInput({ model: "provider-b/other" }))
  assert.equal(event.input.model, "provider-a/model-a")
})

test("关闭策略后不再改写输入，恢复原有选择规则", async () => {
  const storage = fakeStorage(enabledPolicy("provider-a/model-a#high"))
  const { host, handlers } = await register({ storage, models: CATALOG })

  const saved = await handlers.setSubagentModel({ model: null })
  assert.equal(saved.ok, true)
  assert.equal(saved.model, null)

  const bare = subagentInput()
  assert.deepEqual((await intercept(host, bare)).input, bare)
  assert.equal((await handlers.getSubagentModel({})).model, null)
})

test("策略存在共享存储中：A 保存后 B 下一次拦截立即生效，重新注册的实例仍读取", async () => {
  const storage = fakeStorage()
  const a = await register({ storage, models: CATALOG })
  const b = await register({ storage, models: CATALOG })

  const saved = await a.handlers.setSubagentModel({ model: "provider-a/model-a#low" })
  assert.equal(saved.ok, true)

  const eventB = await intercept(b.host, subagentInput())
  assert.equal(eventB.input.model, "provider-a/model-a#low")

  const reloaded = await register({ storage, models: CATALOG })
  const eventC = await intercept(reloaded.host, subagentInput())
  assert.equal(eventC.input.model, "provider-a/model-a#low")
})

test("保存时拒绝未知模型、非聊天模型、非法变体与非法引用，旧设置不变", async () => {
  const storage = fakeStorage(enabledPolicy("provider-a/model-a"))
  const { handlers } = await register({ storage, models: CATALOG })

  const rejected = [
    "provider-a/missing",
    "provider-a/vision",
    "provider-a/model-a#ultra",
    "no-slash",
    "",
    "provider-a/model-a#high#x",
  ]
  for (const model of rejected) {
    const summary = await handlers.setSubagentModel({ model })
    assert.equal(summary.ok, false, `应拒绝 ${JSON.stringify(model)}`)
    assert.equal(summary.supported, true)
    assert.ok((summary.errors ?? []).length > 0, `拒绝 ${JSON.stringify(model)} 时应说明原因`)
  }

  assert.deepEqual(storage.map.get(POLICY_KEY), { model: "provider-a/model-a" })
})

test("模型 ID 含 / 也能保存并生效", async () => {
  const storage = fakeStorage()
  const { host, handlers } = await register({ storage, models: CATALOG })

  const saved = await handlers.setSubagentModel({ model: "provider-a/model/img#high" })
  assert.equal(saved.ok, true)
  assert.equal(saved.model, "provider-a/model/img#high")

  const event = await intercept(host, subagentInput())
  assert.equal(event.input.model, "provider-a/model/img#high")
})

test("关闭策略不依赖模型目录可用", async () => {
  const storage = fakeStorage(enabledPolicy("provider-a/model-a"))
  const { host, handlers } = await register({ storage, models: "none" })

  const saved = await handlers.setSubagentModel({ model: null })
  assert.equal(saved.ok, true)

  const input = subagentInput()
  assert.deepEqual((await intercept(host, input)).input, input)
  assert.equal((await handlers.getSubagentModel({})).ok, true)
})

test("存储读取失败时阻止 subagent 调用", async () => {
  const storage = fakeStorage()
  storage.failGet = true
  const { host } = await register({ storage, models: CATALOG })

  await assert.rejects(() => intercept(host, subagentInput()), /subagent model policy/i)
})

test("持久值损坏时阻止 subagent 调用", async () => {
  for (const stored of ["provider-a/model-a", { model: 42 }, {}, { model: "no-slash" }]) {
    const { host } = await register({ storage: fakeStorage({ [POLICY_KEY]: stored }), models: CATALOG })
    await assert.rejects(
      () => intercept(host, subagentInput()),
      /subagent model policy/i,
      `损坏值 ${JSON.stringify(stored)} 应阻止调用`,
    )
  }
})

test("保存写入失败时报告失败并保留旧设置", async () => {
  const storage = fakeStorage(enabledPolicy("provider-a/model-a"))
  storage.failSet = true
  const { handlers } = await register({ storage, models: CATALOG })

  const summary = await handlers.setSubagentModel({ model: "provider-a/model-a#high" })
  assert.equal(summary.ok, false)
  assert.ok((summary.errors ?? []).length > 0)
  assert.deepEqual(storage.map.get(POLICY_KEY), { model: "provider-a/model-a" })
})

test("宿主没有执行前钩子时明确不支持，且不谎报保存成功", async () => {
  const storage = fakeStorage()
  const { handlers } = await register({ storage, models: CATALOG, hook: false })

  const current = await handlers.getSubagentModel({})
  assert.equal(current.ok, false)
  assert.equal(current.supported, false)

  const saved = await handlers.setSubagentModel({ model: "provider-a/model-a" })
  assert.equal(saved.ok, false)
  assert.equal(saved.supported, false)
  assert.equal(storage.map.has(POLICY_KEY), false, "不支持时不应写入策略")
})

test("钩子注册失败时不抛错，而是明确不支持", async () => {
  const storage = fakeStorage()
  const { handlers } = await register({
    storage,
    models: CATALOG,
    hookError: new Error("hook unavailable"),
  })

  const saved = await handlers.setSubagentModel({ model: "provider-a/model-a" })
  assert.equal(saved.ok, false)
  assert.equal(saved.supported, false)
  assert.equal(storage.map.has(POLICY_KEY), false)
})
