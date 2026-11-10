import assert from "node:assert/strict"
import { test } from "node:test"

import { registerSubagentModelPolicy } from "../plugin/opencode-providers/subagent-model.ts"
import { configureSubagentModel } from "../plugin/opencode-providers/view/subagent-model.ts"

const POLICY_KEY = "subagent-model-policy"
const CURRENT_LOCATION = { directory: "D:\\projects\\demo" }
const DEFAULT_LOCATION = { directory: "D:\\projects\\default" }

interface ModelInfo {
  readonly id: string
  readonly providerID: string
  readonly name: string
  readonly type?: string
  readonly variants?: readonly { readonly id: string }[]
}

interface ProviderInfo {
  readonly id: string
  readonly name: string
}

const ALPHA: ModelInfo = {
  id: "alpha",
  providerID: "provider-a",
  name: "Alpha",
  type: "chat",
  variants: [{ id: "high" }, { id: "low" }],
}

const BETA: ModelInfo = { id: "beta", providerID: "provider-b", name: "Beta" }
const VISION: ModelInfo = { id: "vision", providerID: "provider-a", name: "Vision", type: "image" }

const PROVIDERS: readonly ProviderInfo[] = [
  { id: "provider-a", name: "Provider A" },
  { id: "provider-b", name: "Provider B" },
]

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
        if (state.failGet) throw new Error("存储读取失败")
        return map.get(key)
      },
      async set(key, value) {
        if (state.failSet) throw new Error("存储写入失败")
        map.set(key, value)
      },
    },
  }
  return state
}

type Step = { kind: "select"; value?: unknown } | { kind: "title"; title: string }

interface HarnessInput {
  /** 省略 = 没有策略键；null = 已明确关闭。 */
  readonly policy?: string | null
  /** 字符串表示模型目录读取失败的几种方式。 */
  readonly models?: readonly ModelInfo[] | "sync-error" | "list-error" | "always-unloaded"
  readonly providers?: readonly ProviderInfo[]
  readonly location?: { directory: string }
  readonly defaultLocation?: { directory: string }
  readonly script: Step[]
  readonly hook?: boolean
  readonly storage?: FakeStorage
  readonly getThrows?: Error
}

async function harness(input: HarnessInput) {
  const calls = {
    getLocations: [] as unknown[],
    setLocations: [] as unknown[],
    modelListLocations: [] as unknown[],
    modelSyncLocations: [] as unknown[],
    toast: [] as Array<{ variant?: string; message: string }>,
    selects: [] as any[],
  }
  const storage =
    input.storage ??
    fakeStorage(input.policy === undefined ? {} : { [POLICY_KEY]: { model: input.policy } })
  const catalog = typeof input.models === "string" ? [] : (input.models ?? [])
  const queue = [...input.script]

  const policyContext: Record<string, unknown> = { storage: storage.api }
  if (input.hook !== false) {
    policyContext.tool = {
      hook: async () => ({ dispose: async () => {} }),
    }
  }
  policyContext.model = {
    list: async (query?: { types?: readonly string[] }) => {
      const types = query?.types
      const data =
        types === undefined ? catalog : catalog.filter((model) => types.includes(model.type ?? "chat"))
      return { location: {}, data }
    },
  }
  const handlers = await registerSubagentModelPolicy(policyContext as never)

  const ctx: any = {
    location: input.location,
    client: {
      rpc: () => ({
        getSubagentModel: async (value: unknown, options?: { location?: unknown }) => {
          calls.getLocations.push(options?.location)
          if (input.getThrows !== undefined) throw input.getThrows
          return handlers.getSubagentModel(value)
        },
        setSubagentModel: async (value: unknown, options?: { location?: unknown }) => {
          calls.setLocations.push(options?.location)
          return handlers.setSubagentModel(value)
        },
      }),
    },
    data: {
      location: {
        default: () => input.defaultLocation ?? DEFAULT_LOCATION,
        model: {
          list: (location: unknown) => {
            calls.modelListLocations.push(location)
            if (input.models === "list-error") throw new Error("模型目录读取失败")
            if (input.models === "sync-error" || input.models === "always-unloaded") return undefined
            return [...catalog]
          },
          sync: async (location: unknown) => {
            calls.modelSyncLocations.push(location)
            if (input.models === "sync-error") throw new Error("模型目录同步失败")
          },
          invalidate: () => {},
        },
        provider: {
          list: () => [...(input.providers ?? [])],
          sync: async () => {},
          invalidate: () => {},
        },
      },
    },
    ui: {
      toast: {
        show: (options: { variant?: string; message: string }) => calls.toast.push(options),
      },
      dialog: {
        select: async (options: any) => {
          calls.selects.push(options)
          const step = queue.shift()
          if (step === undefined) throw new Error("测试脚本用完了：界面打开了额外的选择框")
          if (step.kind === "select") return step.value
          const option = options.options.find((candidate: any) => candidate.title === step.title)
          assert.ok(option, `选择框里应有「${step.title}」`)
          return option.value
        },
      },
    },
  }

  return { ctx, calls, storage }
}

const DISABLE = "关闭强制覆盖（恢复 OpenCode 原有选择规则）"

test("模型列表覆盖所有供应商的聊天模型、按供应商分组，并显示当前完整引用", async () => {
  const h = await harness({
    policy: "provider-a/alpha#high",
    models: [ALPHA, BETA, VISION],
    providers: PROVIDERS,
    location: CURRENT_LOCATION,
    script: [{ kind: "select" }],
  })
  await configureSubagentModel(h.ctx)

  const dialog = h.calls.selects[0]
  assert.match(dialog.title, /子代理统一模型/)
  assert.match(dialog.title, /Provider A/)
  assert.match(dialog.title, /Alpha/)
  assert.match(dialog.title, /provider-a\/alpha#high/)
  assert.equal(dialog.current, "provider-a/alpha", "当前模型所在行应被标记")

  const titles = dialog.options.map((option: any) => option.title)
  assert.ok(titles[0].includes(DISABLE), "首个选项是关闭强制覆盖")
  assert.ok(
    titles.some((title: string) => title.includes("provider-a/alpha")),
    "当前模型行应显示完整引用",
  )
  assert.ok(
    titles.some((title: string) => title.includes("provider-b/beta")),
    "其他供应商的聊天模型也应出现",
  )
  assert.equal(
    titles.some((title: string) => title.includes("vision")),
    false,
    "非聊天模型不应出现",
  )

  const categories = new Set(dialog.options.map((option: any) => option.category).filter(Boolean))
  assert.deepEqual(categories, new Set(["Provider A", "Provider B"]))
})

test("选择模型和变体后经真实策略保存完整引用", async () => {
  const h = await harness({
    models: [ALPHA],
    providers: PROVIDERS,
    location: CURRENT_LOCATION,
    script: [
      { kind: "select", value: "provider-a/alpha" },
      { kind: "title", title: "low" },
    ],
  })
  await configureSubagentModel(h.ctx)

  assert.deepEqual(h.storage.map.get(POLICY_KEY), { model: "provider-a/alpha#low" })
  assert.ok(h.calls.toast.some((toast) => toast.variant === "success"))
})

test("选择默认变体时保存的引用不带 #", async () => {
  const h = await harness({
    models: [ALPHA],
    providers: PROVIDERS,
    script: [
      { kind: "select", value: "provider-a/alpha" },
      { kind: "title", title: "默认（不附加变体）" },
    ],
  })
  await configureSubagentModel(h.ctx)

  assert.deepEqual(h.storage.map.get(POLICY_KEY), { model: "provider-a/alpha" })
  assert.ok(h.calls.toast.some((toast) => toast.variant === "success"))
})

test("选择无变体的模型时直接保存，不再追问变体", async () => {
  const h = await harness({
    models: [BETA],
    providers: PROVIDERS,
    script: [{ kind: "select", value: "provider-b/beta" }],
  })
  await configureSubagentModel(h.ctx)

  assert.deepEqual(h.storage.map.get(POLICY_KEY), { model: "provider-b/beta" })
})

test("取消首层或变体选择都不写全局设置", async () => {
  const first = await harness({
    policy: "provider-a/alpha#high",
    models: [ALPHA],
    providers: PROVIDERS,
    script: [{ kind: "select" }],
  })
  await configureSubagentModel(first.ctx)
  assert.deepEqual(first.storage.map.get(POLICY_KEY), { model: "provider-a/alpha#high" })
  assert.equal(first.calls.toast.some((toast) => toast.variant === "success"), false)

  const second = await harness({
    policy: "provider-a/alpha#high",
    models: [ALPHA],
    providers: PROVIDERS,
    script: [{ kind: "select", value: "provider-a/alpha" }, { kind: "select" }],
  })
  await configureSubagentModel(second.ctx)
  assert.deepEqual(second.storage.map.get(POLICY_KEY), { model: "provider-a/alpha#high" })
  assert.equal(second.calls.toast.some((toast) => toast.variant === "success"), false)
})

test("选择关闭强制覆盖后保存 null", async () => {
  const h = await harness({
    policy: "provider-a/alpha#high",
    models: [ALPHA],
    providers: PROVIDERS,
    script: [{ kind: "title", title: DISABLE }],
  })
  await configureSubagentModel(h.ctx)

  assert.deepEqual(h.storage.map.get(POLICY_KEY), { model: null })
  assert.ok(h.calls.toast.some((toast) => toast.variant === "success"))
})

test("当前模型失效时仍显示原引用，并允许关闭覆盖", async () => {
  const h = await harness({
    policy: "provider-a/removed#high",
    models: [ALPHA],
    providers: PROVIDERS,
    script: [{ kind: "title", title: DISABLE }],
  })
  await configureSubagentModel(h.ctx)

  const dialog = h.calls.selects[0]
  assert.match(dialog.title, /provider-a\/removed#high/)
  assert.ok(dialog.options[0].title.includes(DISABLE))
  assert.deepEqual(h.storage.map.get(POLICY_KEY), { model: null })
})

test("目录没有可用聊天模型时仍显示原引用并允许关闭覆盖", async () => {
  const h = await harness({
    policy: "provider-a/removed#high",
    models: [VISION],
    providers: PROVIDERS,
    script: [{ kind: "title", title: DISABLE }],
  })
  await configureSubagentModel(h.ctx)

  const dialog = h.calls.selects[0]
  assert.match(dialog.title, /provider-a\/removed#high/)
  assert.equal(dialog.options.length, 1, "只剩关闭选项")
  assert.deepEqual(h.storage.map.get(POLICY_KEY), { model: null })
})

test("模型目录读取失败时明确报错，不伪装成空列表", async () => {
  for (const mode of ["sync-error", "list-error", "always-unloaded"] as const) {
    const h = await harness({ models: mode, providers: PROVIDERS, script: [] })
    await configureSubagentModel(h.ctx)

    assert.equal(h.calls.selects.length, 0, `${mode} 时不应打开选择框`)
    assert.ok(
      h.calls.toast.some((toast) => toast.variant === "error" && /无法读取模型列表/.test(toast.message)),
      `${mode} 时应明确提示模型列表读取失败`,
    )
  }
})

test("RPC 与模型读取绑定当前 location，缺省时使用 data.location.default()", async () => {
  const explicit = await harness({
    models: [ALPHA],
    providers: PROVIDERS,
    location: CURRENT_LOCATION,
    script: [
      { kind: "select", value: "provider-a/alpha" },
      { kind: "title", title: "默认（不附加变体）" },
    ],
  })
  await configureSubagentModel(explicit.ctx)
  assert.deepEqual(explicit.storage.map.get(POLICY_KEY), { model: "provider-a/alpha" })
  assert.ok(explicit.calls.getLocations.length > 0)
  assert.ok(explicit.calls.modelListLocations.length > 0)
  assert.ok(explicit.calls.setLocations.length > 0, "保存也应带当前 location")
  for (const location of [
    ...explicit.calls.getLocations,
    ...explicit.calls.setLocations,
    ...explicit.calls.modelListLocations,
    ...explicit.calls.modelSyncLocations,
  ]) {
    assert.deepEqual(location, CURRENT_LOCATION)
  }

  const fallback = await harness({
    models: [ALPHA],
    providers: PROVIDERS,
    defaultLocation: DEFAULT_LOCATION,
    script: [
      { kind: "select", value: "provider-a/alpha" },
      { kind: "title", title: "默认（不附加变体）" },
    ],
  })
  await configureSubagentModel(fallback.ctx)
  assert.deepEqual(fallback.storage.map.get(POLICY_KEY), { model: "provider-a/alpha" })
  assert.ok(fallback.calls.getLocations.length > 0)
  assert.ok(fallback.calls.modelListLocations.length > 0)
  assert.ok(fallback.calls.setLocations.length > 0, "保存也应带默认 location")
  for (const location of [
    ...fallback.calls.getLocations,
    ...fallback.calls.setLocations,
    ...fallback.calls.modelListLocations,
    ...fallback.calls.modelSyncLocations,
  ]) {
    assert.deepEqual(location, DEFAULT_LOCATION)
  }
})

test("保存失败时不提示成功，旧设置保持不变", async () => {
  const storage = fakeStorage({ [POLICY_KEY]: { model: "provider-a/alpha#high" } })
  storage.failSet = true
  const h = await harness({
    storage,
    models: [ALPHA],
    providers: PROVIDERS,
    script: [
      { kind: "select", value: "provider-a/alpha" },
      { kind: "title", title: "默认（不附加变体）" },
    ],
  })
  await configureSubagentModel(h.ctx)

  assert.equal(h.calls.toast.some((toast) => toast.variant === "success"), false)
  assert.ok(h.calls.toast.some((toast) => toast.variant === "error" && /保存/.test(toast.message)))
  assert.deepEqual(storage.map.get(POLICY_KEY), { model: "provider-a/alpha#high" })
})

test("宿主缺少执行前钩子时提示不可用，且不打开选择框", async () => {
  const h = await harness({
    hook: false,
    models: [ALPHA],
    providers: PROVIDERS,
    script: [],
  })
  await configureSubagentModel(h.ctx)

  assert.equal(h.calls.selects.length, 0)
  assert.equal(h.storage.map.has(POLICY_KEY), false, "不支持时不应写入策略")
  assert.ok(h.calls.toast.some((toast) => toast.variant === "error" && /不支持/.test(toast.message)))
})

test("读取策略失败时明确报错，且不打开选择框", async () => {
  const storage = fakeStorage({ [POLICY_KEY]: { model: "provider-a/alpha" } })
  storage.failGet = true
  const broken = await harness({ storage, models: [ALPHA], providers: PROVIDERS, script: [] })
  await configureSubagentModel(broken.ctx)
  assert.equal(broken.calls.selects.length, 0)
  assert.ok(
    broken.calls.toast.some(
      (toast) => toast.variant === "error" && /无法读取子代理模型设置/.test(toast.message),
    ),
  )

  const thrown = await harness({
    getThrows: new Error("rpc 不可用"),
    models: [ALPHA],
    providers: PROVIDERS,
    script: [],
  })
  await configureSubagentModel(thrown.ctx)
  assert.equal(thrown.calls.selects.length, 0)
  assert.ok(
    thrown.calls.toast.some(
      (toast) => toast.variant === "error" && /无法读取子代理模型设置/.test(toast.message),
    ),
  )
})
