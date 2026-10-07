import assert from "node:assert/strict"
import test from "node:test"

import { connectProviders, forceRefresh } from "../plugin/opencode-providers/view/connect.ts"

// ─── /connect-providers 交互测试：脚本化假 ctx，零网络 ───
//
// 插件侧 `dialog.select` 是一次性的：动作触发时只记录意图并关窗，真正的动作逻辑
// （改名/删除/刷新）在 `connectProviders` 外面跑，然后重开弹窗。所以测试用一段
// 「脚本」逐次喂给 select/prompt/confirm，模拟用户的按键与输入。

type Script =
  | { kind: "select"; value?: string } // 省略 value = 取消
  | { kind: "action"; title: string; value?: string }
  | { kind: "prompt"; value?: string } // 省略 value = 取消
  | { kind: "confirm"; value?: boolean } // 省略 = 直接关闭

function harness(input: {
  accounts?: Array<{ id: string; label: string }>
  script?: Script[]
  refresh?: () => Promise<unknown>
  integrations?: () => unknown[]
}) {
  const calls = {
    activate: [] as string[],
    update: [] as Array<{ credentialID: string; label: string }>,
    remove: [] as string[],
    connectKey: [] as Array<{ integrationID: string; key: string }>,
    refresh: 0,
    invalidate: 0,
    toast: [] as any[],
    alert: [] as any[],
    selectOptions: [] as any[],
    clear: 0,
  }
  let accounts = (input.accounts ?? [{ id: "cred_personal", label: "Personal" }]).map((account) => ({ ...account }))
  const queue = [...(input.script ?? [])]

  const next = (): Script => {
    const item = queue.shift()
    if (!item) throw new Error("测试脚本用完了")
    return item
  }

  const integration = () => ({
    id: "acme",
    name: "Acme",
    metadata: { source: "opencode-providers" },
    connections: accounts.map((account) => ({ type: "credential" as const, id: account.id, label: account.label })),
  })

  const ctx: any = {
    location: {},
    client: {
      rpc: () => ({
        refresh: async () => {
          calls.refresh += 1
          return input.refresh
            ? await input.refresh()
            : { ok: true, providers: 1, models: 1, source: "network", fetchedAt: 1 }
        },
      }),
      credential: {
        activate: async ({ credentialID }: { credentialID: string }) => {
          calls.activate.push(credentialID)
          const hit = accounts.find((account) => account.id === credentialID)
          if (hit) accounts = [hit, ...accounts.filter((account) => account.id !== credentialID)]
        },
        update: async ({ credentialID, label }: { credentialID: string; label: string }) => {
          calls.update.push({ credentialID, label })
          accounts = accounts.map((account) => (account.id === credentialID ? { ...account, label } : account))
        },
        remove: async ({ credentialID }: { credentialID: string }) => {
          calls.remove.push(credentialID)
          accounts = accounts.filter((account) => account.id !== credentialID)
        },
      },
      integration: {
        connect: {
          key: async (value: { integrationID: string; key: string }) => {
            calls.connectKey.push(value)
          },
        },
      },
    },
    data: {
      location: {
        integration: {
          list: () => (input.integrations ? input.integrations() : [integration()]),
          invalidate: () => {
            calls.invalidate += 1
          },
          sync: async () => {},
        },
      },
    },
    ui: {
      toast: { show: (options: any) => calls.toast.push(options) },
      dialog: {
        select: async (options: any) => {
          calls.selectOptions.push(options)
          while (true) {
            const item = next()
            if (item.kind === "select") return item.value
            if (item.kind === "action") {
              const action = options.actions?.find((candidate: any) => candidate.title === item.title)
              assert.ok(action, `应有 action: ${item.title}`)
              // 宿主的真实语义：触发 action 不会关窗；只有 onTrigger 自己 clear 才会。
              const before = calls.clear
              action.onTrigger(item.value)
              if (calls.clear > before) return undefined
              continue
            }
            throw new Error(`select 收到非 select 脚本：${item.kind}`)
          }
        },
        prompt: async () => {
          const item = next()
          if (item.kind !== "prompt") throw new Error(`prompt 收到非 prompt 脚本：${item.kind}`)
          return item.value
        },
        confirm: async () => {
          const item = next()
          if (item.kind !== "confirm") throw new Error(`confirm 收到非 confirm 脚本：${item.kind}`)
          return item.value
        },
        alert: (options: any) => {
          calls.alert.push(options)
          return Promise.resolve()
        },
        clear: () => {
          calls.clear += 1
        },
      },
    },
  }

  return { ctx, calls, get accounts() { return accounts } }
}

// ─── forceRefresh：纯逻辑（不含阻塞模态） ───

test("forceRefresh 成功：调 rpc.refresh、invalidate、success toast", async () => {
  const seen = { refresh: 0, toasts: [] as any[], invalidated: 0 }
  const ctx = {
    location: {},
    client: {
      rpc: () => ({
        refresh: async () => {
          seen.refresh += 1
          return { ok: true, providers: 2, models: 2, source: "network", fetchedAt: 1 }
        },
      }),
    },
    ui: { toast: { show: (o: any) => seen.toasts.push(o) } },
    data: { location: { integration: { invalidate: () => void (seen.invalidated += 1) } } },
  }
  assert.equal(await forceRefresh(ctx as any), true)
  assert.equal(seen.refresh, 1)
  assert.equal(seen.invalidated, 1)
  assert.equal(seen.toasts[0]?.variant, "success")
})

test("forceRefresh 失败：error toast、不 invalidate", async () => {
  const seen = { toasts: [] as any[], invalidated: 0 }
  const ctx = {
    location: {},
    client: { rpc: () => ({ refresh: async () => ({ ok: false, errors: ["boom"] }) }) },
    ui: { toast: { show: (o: any) => seen.toasts.push(o) } },
    data: { location: { integration: { invalidate: () => void (seen.invalidated += 1) } } },
  }
  assert.equal(await forceRefresh(ctx as any), false)
  assert.equal(seen.invalidated, 0)
  assert.equal(seen.toasts[0]?.variant, "error")
})

test("forceRefresh 单飞：并发调用共用同一次刷新", async () => {
  let release: (value: unknown) => void = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const h = harness({ script: [], refresh: () => gate as Promise<unknown> })

  const first = forceRefresh(h.ctx)
  const second = forceRefresh(h.ctx)
  release({ ok: true, providers: 0, models: 0, source: "network", fetchedAt: 1 })

  assert.equal(await first, true)
  assert.equal(await second, true)
  assert.equal(h.calls.refresh, 1, "并发应只打一次网络")
})

// ─── 供应商列表 ───

test("非空态：列表带 'Force refresh' + ctrl+r 的 action", async () => {
  const h = harness({ script: [{ kind: "select" }] })
  await connectProviders(h.ctx)
  const action = h.calls.selectOptions[0]?.actions?.find((item: any) => item.title === "Force refresh")
  assert.ok(action, "应有 Force refresh action")
  assert.equal(action.bind, "ctrl+r")
  assert.equal(action.selection, "none")
})

test("按 Force refresh：先上阻塞模态，刷新后清掉，再重开列表", async () => {
  const h = harness({ script: [{ kind: "action", title: "Force refresh" }, { kind: "select" }] })
  await connectProviders(h.ctx)

  assert.equal(h.calls.alert.length, 1, "刷新期间应有阻塞模态")
  assert.match(h.calls.alert[0].message, /Refreshing/)
  assert.equal(h.calls.refresh, 1)
  assert.equal(h.calls.invalidate, 1)
  assert.ok(h.calls.clear >= 1, "刷新结束必须撤掉模态")
  assert.equal(h.calls.selectOptions.length, 2, "刷新后应重开供应商列表")
  assert.ok(h.calls.toast.some((toast) => toast.variant === "success"))
})

test("空态：confirm 确认后走阻塞刷新并提示已重载", async () => {
  const h = harness({ integrations: () => [], script: [{ kind: "confirm", value: true }] })
  await connectProviders(h.ctx)
  assert.equal(h.calls.refresh, 1)
  assert.equal(h.calls.alert.length, 1)
  assert.ok(h.calls.clear >= 1)
  assert.ok(h.calls.toast.some((toast) => toast.variant === "info"))
})

test("空态：刷新失败时不谎报「已重载」", async () => {
  const h = harness({
    integrations: () => [],
    script: [{ kind: "confirm", value: true }],
    refresh: async () => ({ ok: false, errors: ["boom"] }),
  })
  await connectProviders(h.ctx)
  assert.equal(h.calls.toast.filter((toast) => toast.variant === "info").length, 0)
  assert.equal(h.calls.toast.filter((toast) => toast.variant === "error").length, 1)
})

// ─── 账号管理 ───

test("账号管理：列出 Add account + 各账号，激活项带 active footer", async () => {
  const h = harness({
    accounts: [
      { id: "cred_work", label: "Work" },
      { id: "cred_personal", label: "Personal" },
    ],
    script: [{ kind: "select", value: "acme" }, { kind: "select" }],
  })
  await connectProviders(h.ctx)

  const manager = h.calls.selectOptions[1]
  assert.equal(manager.title, "Acme")
  assert.equal(manager.current, "cred_work", "首个凭据视为激活项")
  const add = manager.options.find((option: any) => option.title === "Add account")
  assert.ok(add, "应有 Add account")
  const personal = manager.options.find((option: any) => option.title === "Personal")
  assert.equal(personal.category, "Accounts")
  assert.equal(personal.footer, undefined)
  const work = manager.options.find((option: any) => option.title === "Work")
  assert.equal(work.footer, "active")
})

test("选择另一个账号：activate 后留在弹窗，刷新出新激活项", async () => {
  const h = harness({
    accounts: [
      { id: "cred_work", label: "Work" },
      { id: "cred_personal", label: "Personal" },
    ],
    script: [{ kind: "select", value: "acme" }, { kind: "select", value: "cred_personal" }, { kind: "select" }],
  })
  await connectProviders(h.ctx)
  assert.deepEqual(h.calls.activate, ["cred_personal"])
  assert.equal(h.calls.selectOptions.length, 3, "激活后应重开账号管理")
  const reopened = h.calls.selectOptions[2]
  assert.equal(reopened.current, "cred_personal")
  assert.ok(h.calls.toast.some((toast) => toast.variant === "success" && /Activated/.test(toast.message)))
})

test("选择已激活账号：不发 activate（no-op）", async () => {
  const h = harness({
    accounts: [{ id: "cred_personal", label: "Personal" }],
    script: [{ kind: "select", value: "acme" }, { kind: "select", value: "cred_personal" }, { kind: "select" }],
  })
  await connectProviders(h.ctx)
  assert.deepEqual(h.calls.activate, [])
})

test("ctrl+r 改名：预填 label，update 后留在弹窗", async () => {
  const h = harness({
    accounts: [
      { id: "cred_personal", label: "Personal" },
      { id: "cred_work", label: "Work" },
    ],
    script: [
      { kind: "select", value: "acme" },
      { kind: "action", title: "rename", value: "cred_personal" },
      { kind: "prompt", value: "  Personal 2  " },
      { kind: "select" },
    ],
  })
  await connectProviders(h.ctx)

  const rename = h.calls.selectOptions[1].actions.find((item: any) => item.title === "rename")
  assert.equal(rename.bind, "ctrl+r")
  assert.equal(rename.selection, "required")
  assert.deepEqual(h.calls.update, [{ credentialID: "cred_personal", label: "Personal 2" }])
  assert.equal(h.calls.selectOptions.length, 3, "改名后应重开账号管理")
  const reopened = h.calls.selectOptions[2]
  assert.equal(reopened.current, "cred_personal", "首个凭据仍是激活项")
  assert.ok(
    reopened.options.some((option: any) => option.title === "Personal 2"),
    "重开的列表应显示新 label",
  )
  assert.ok(h.calls.toast.some((toast) => /Renamed to Personal 2/.test(toast.message)))
})

test("ctrl+r 改名：空输入不发起 update", async () => {
  const h = harness({
    accounts: [{ id: "cred_personal", label: "Personal" }],
    script: [
      { kind: "select", value: "acme" },
      { kind: "action", title: "rename", value: "cred_personal" },
      { kind: "prompt", value: "   " },
      { kind: "select" },
    ],
  })
  await connectProviders(h.ctx)
  assert.deepEqual(h.calls.update, [])
})

test("在 Add account 行按 ctrl+r：no-op（动作无法隐藏，故守卫）", async () => {
  const h = harness({
    accounts: [{ id: "cred_personal", label: "Personal" }],
    script: [
      { kind: "select", value: "acme" },
      { kind: "action", title: "rename", value: "\u0000add-account" },
      { kind: "select" },
    ],
  })
  await connectProviders(h.ctx)
  assert.deepEqual(h.calls.update, [])
  assert.equal(h.calls.selectOptions.length, 2, "动作用户可继续操作，弹窗未重开")
})

test("ctrl+d 删除（非最后一个）：确认后 remove，留在弹窗且不报 Disconnected", async () => {
  const h = harness({
    accounts: [
      { id: "cred_personal", label: "Personal" },
      { id: "cred_work", label: "Work" },
    ],
    script: [
      { kind: "select", value: "acme" },
      { kind: "action", title: "delete", value: "cred_work" },
      { kind: "confirm", value: true },
      { kind: "select" },
    ],
  })
  await connectProviders(h.ctx)

  const action = h.calls.selectOptions[1].actions.find((item: any) => item.title === "delete")
  assert.equal(action.bind, "ctrl+d")
  assert.deepEqual(h.calls.remove, ["cred_work"])
  assert.equal(h.calls.selectOptions.length, 3, "删除后应重开账号管理")
  assert.equal(h.calls.toast.filter((toast) => /Disconnected/.test(toast.message)).length, 0)
})

test("ctrl+d 删除（最后一个）：确认后 remove、toast Disconnected 并关闭", async () => {
  const h = harness({
    accounts: [{ id: "cred_only", label: "Only" }],
    script: [
      { kind: "select", value: "acme" },
      { kind: "action", title: "delete", value: "cred_only" },
      { kind: "confirm", value: true },
    ],
  })
  await connectProviders(h.ctx)
  assert.deepEqual(h.calls.remove, ["cred_only"])
  assert.equal(h.calls.selectOptions.length, 2, "删最后一个后不再重开")
  assert.ok(h.calls.toast.some((toast) => /Disconnected Acme/.test(toast.message)))
})

test("ctrl+d 删除：取消确认则不动", async () => {
  const h = harness({
    accounts: [{ id: "cred_only", label: "Only" }],
    script: [
      { kind: "select", value: "acme" },
      { kind: "action", title: "delete", value: "cred_only" },
      { kind: "confirm", value: false },
      { kind: "select" },
    ],
  })
  await connectProviders(h.ctx)
  assert.deepEqual(h.calls.remove, [])
})

test("无账号：直接进入贴 key 流程", async () => {
  const h = harness({
    accounts: [],
    script: [{ kind: "select", value: "acme" }, { kind: "prompt", value: "sk-test" }],
  })
  await connectProviders(h.ctx)
  assert.equal(h.calls.selectOptions.length, 1, "无账号不显示账号管理")
  assert.deepEqual(h.calls.connectKey, [{ integrationID: "acme", key: "sk-test" }])
})
