import assert from "node:assert/strict"
import test from "node:test"

import { connectProviders, forceRefresh } from "../plugin/opencode-providers/view/connect.ts"

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
  await forceRefresh(ctx as any)
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
  await forceRefresh(ctx as any)
  assert.equal(seen.invalidated, 0)
  assert.equal(seen.toasts[0]?.variant, "error")
})

test("非空态：dialog.select 收到 'Force refresh' + mod+r 的 action", async () => {
  let captured: any
  const ctx = {
    location: {},
    data: {
      location: {
        integration: {
          list: () => [{ id: "acme", name: "Acme", connections: [], metadata: { source: "opencode-providers" } }],
        },
      },
    },
    ui: {
      dialog: {
        select: async (options: any) => {
          captured = options
          return undefined
        },
      },
    },
  }
  await connectProviders(ctx as any)
  const action = captured.actions.find((item: any) => item.title === "Force refresh")
  assert.ok(action, "应有 Force refresh action")
  assert.equal(action.bind, "mod+r")
  assert.equal(action.selection, "none")
})

test("空态：confirm 确认后触发 forceRefresh（评审 D）", async () => {
  const seen = { refresh: 0 }
  const ctx = {
    location: {},
    data: { location: { integration: { list: () => [], invalidate: () => {} } } },
    client: {
      rpc: () => ({
        refresh: async () => {
          seen.refresh += 1
          return { ok: true, providers: 0, models: 0, source: "network", fetchedAt: 1 }
        },
      }),
    },
    ui: { dialog: { confirm: async () => true }, toast: { show: () => {} } },
  }
  await connectProviders(ctx as any)
  assert.equal(seen.refresh, 1)
})