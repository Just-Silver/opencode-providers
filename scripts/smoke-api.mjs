#!/usr/bin/env node
/**
 * 端到端冒烟：完全走 opencode 自己的 HTTP API，**不需要 TUI**。
 *
 *   node scripts/smoke-api.mjs --list
 *   node scripts/smoke-api.mjs                                  # 全部场景
 *   node scripts/smoke-api.mjs --scenario plugin,integrations   # 指定场景
 *   node scripts/smoke-api.mjs --integration command-code        # 指定用哪家供应商做「凭据 → 模型」链路
 *
 * 鉴权：优先读 `~/.local/state/opencode/service.json` 的 url/password（`opencode pair` 已不再打印口令），
 * 也可 `--server http://127.0.0.1:PORT --password xxx` 显式指定。
 *
 * ⚠️ `models` 场景会**真的写入并删除**一条临时凭据（label = smoke-throwaway）：
 *    只对「当前没有凭据」的 supplier 生效，跑完即删；请勿拿正在干活的实例当试验场。
 *
 * 场景：plugin（插件已加载）/ integrations（供应商已注册）/ models（凭据 → 模型 → 清理）
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const SOURCE = "opencode-providers"
const THROWAWAY_LABEL = "smoke-throwaway"

const scenarios = {
  plugin: {
    title: "插件已加载且双入口就绪（/api/plugin）",
    run: async (ctx) => {
      const list = await ctx.api("/api/plugin")
      const ours = list.data.filter((item) => item.id === "opencode-providers")
      ctx.check(ours.length === 1, `id=opencode-providers 条目数 = ${ours.length}（期望 1；>1 说明同一插件被发现了两次）`)
      const entry = ours[0]
      if (!entry) return
      ctx.check(entry.state?.status === "active", `state.status = ${entry.state?.status}（期望 active）`)
      ctx.check(entry.features?.server === true, `features.server = ${entry.features?.server}（期望 true）`)
      ctx.check(entry.features?.tui === true, `features.tui = ${entry.features?.tui}（期望 true，需 index.ts + tui.ts 都在）`)
      ctx.info(`source = ${JSON.stringify(entry.source)}`)
    },
  },
  integrations: {
    title: "注册表里的供应商已注册为 integration（/api/integration）",
    run: async (ctx) => {
      const list = await ctx.api("/api/integration")
      ctx.ours = list.data.filter((item) => item.metadata?.source === SOURCE)
      ctx.check(ctx.ours.length >= 1, `metadata.source=${SOURCE} 的 integration = ${ctx.ours.length}（期望 >= 1）`)
      for (const integration of ctx.ours) {
        const methods = integration.methods ?? []
        ctx.check(
          methods.some((method) => method.type === "key"),
          `${integration.id}: methods = ${JSON.stringify(methods)}（期望含 key）`,
        )
        ctx.info(`${integration.id} | ${integration.name} | connections=${integration.connections.length}`)
      }
    },
  },
  models: {
    title: "凭据 → 模型出现 → 清理后消失（/api/model + /api/integration/<id>/connect/key）",
    run: async (ctx) => {
      const list = await ctx.api("/api/integration")
      const ours = list.data.filter((item) => item.metadata?.source === SOURCE)
      const picked = ctx.option("integration")
        ? ours.find((item) => item.id === ctx.option("integration"))
        : ours[0]
      if (!picked) {
        ctx.check(false, `找不到候选 integration（${ctx.option("integration") ?? "任意"}）；先跑 integrations 场景`)
        return
      }
      ctx.info(`目标供应商 = ${picked.id}`)

      const before = await models(ctx, picked.id)
      ctx.info(`凭据前：${picked.id} 的模型数 = ${before.length}`)
      if (picked.connections.length > 0) {
        ctx.check(true, `${picked.id} 已有 ${picked.connections.length} 条凭据 → 跳过写入（避免动到真实凭据）`)
        ctx.check(before.length > 0, `已有凭据时该 provider 应可用：模型数 = ${before.length}（期望 > 0）`)
        return
      }
      ctx.check(before.length === 0, `无凭据时 activation:auto 不应出现在 /api/model：模型数 = ${before.length}（期望 0）`)

      await ctx.api(`/api/integration/${encodeURIComponent(picked.id)}/connect/key`, {
        method: "POST",
        body: JSON.stringify({ key: "sk-smoke-throwaway", label: THROWAWAY_LABEL }),
      })

      const credentials = await ctx.api("/api/credential")
      const created = credentials.data.filter((item) => item.integrationID === picked.id && item.label === THROWAWAY_LABEL)

      try {
        const after = await models(ctx, picked.id)
        ctx.check(after.length > 0, `写入临时凭据后模型数 = ${after.length}（期望 > 0）`)
        for (const model of after.slice(0, 5)) {
          ctx.info(
            `${model.providerID}/${model.id} modelID=${model.modelID} limit=${JSON.stringify(model.limit)} ` +
              `tools=${model.capabilities?.tools} variants=${(model.variants ?? []).map((variant) => variant.id).join(",") || "-"}`,
          )
        }
        ctx.check(
          after.every((model) => Number.isFinite(model.limit?.context) && Number.isFinite(model.limit?.output)),
          "每个模型都带 limit.context / limit.output（注册表必须写全参数，插件不做推断）",
        )
      } finally {
        for (const credential of created) {
          await ctx.api(`/api/credential/${encodeURIComponent(credential.id)}`, { method: "DELETE" })
        }
        const left = await ctx.api("/api/credential")
        ctx.check(
          left.data.every((item) => item.label !== THROWAWAY_LABEL),
          `临时凭据已清理（剩余 label=${THROWAWAY_LABEL} 的凭据数 = ${left.data.filter((i) => i.label === THROWAWAY_LABEL).length}）`,
        )
        const cleared = await models(ctx, picked.id)
        ctx.check(cleared.length === 0, `清理后模型数 = ${cleared.length}（期望回到 0）`)
      }
    },
  },
}

async function models(ctx, providerID) {
  const list = await ctx.api("/api/model")
  return list.data.filter((item) => item.providerID === providerID)
}

function options(argv) {
  const map = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) continue
    const eq = token.indexOf("=")
    if (eq !== -1) map.set(token.slice(2, eq), token.slice(eq + 1))
    else {
      const next = argv[index + 1]
      if (next && !next.startsWith("--")) {
        map.set(token.slice(2), next)
        index += 1
      } else map.set(token.slice(2), "true")
    }
  }
  return map
}

function resolveServer(argv) {
  const parsed = options(argv)
  const explicit = { url: parsed.get("server"), password: parsed.get("password") }
  if (explicit.url && explicit.password) {
    return { url: explicit.url.replace(/\/$/, ""), password: explicit.password, from: "--server/--password" }
  }
  const file = join(homedir(), ".local", "state", "opencode", "service.json")
  try {
    const service = JSON.parse(readFileSync(file, "utf8"))
    if (service.url && service.password) {
      return { url: String(service.url).replace(/\/$/, ""), password: String(service.password), from: file }
    }
  } catch {}
  fail(
    `读不到 opencode 服务地址/口令。请在配置里找 service.json，或用 --server http://127.0.0.1:PORT --password <口令> 指定。\n（${file}）`,
  )
}

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

async function main() {
  const argv = process.argv.slice(2)
  const parsed = options(argv)

  if (parsed.get("list") === "true") {
    for (const [name, scenario] of Object.entries(scenarios)) console.log(`${name.padEnd(14)} ${scenario.title}`)
    return
  }

  const selected = (parsed.get("scenario") ?? Object.keys(scenarios).join(","))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
  for (const name of selected) if (!scenarios[name]) fail(`未知场景：${name}（--list 查看）`)

  const server = resolveServer(argv)
  const auth = `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`
  const ctx = {
    api: async (path, init = {}) => {
      const response = await fetch(`${server.url}${path}`, {
        ...init,
        headers: { authorization: auth, "content-type": "application/json", ...(init.headers ?? {}) },
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${response.status} ${text.slice(0, 300)}`)
      return text ? JSON.parse(text) : {}
    },
    option: (name) => parsed.get(name),
    check: (condition, label) => {
      ctx.results.push({ ok: Boolean(condition), label })
      console.log(`  ${condition ? "✓" : "✗"} ${label}`)
    },
    info: (label) => console.log(`  · ${label}`),
    results: [],
    ours: [],
  }

  console.log(`服务：${server.url}（来自 ${server.from}）`)
  let failures = 0
  for (const name of selected) {
    const scenario = scenarios[name]
    console.log(`\n[${name}] ${scenario.title}`)
    try {
      await scenario.run(ctx)
    } catch (cause) {
      ctx.check(false, `场景抛错：${cause instanceof Error ? cause.message : String(cause)}`)
    }
    const failed = ctx.results.filter((result) => !result.ok).length
    failures += failed
    console.log(`  → ${failed === 0 ? "PASS" : `FAIL（${failed} 条断言失败）`}`)
    ctx.results = []
  }

  console.log(`\n结果：${selected.length} 个场景，${failures} 条断言失败`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
