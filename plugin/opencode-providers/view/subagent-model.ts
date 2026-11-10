import type { ModelInfo, ProviderInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"

import { registryRpc, type SubagentModelSummary } from "../rpc.ts"

type Context = Plugin.Context
type Location = ReturnType<typeof currentLocation>

const DISABLE_TITLE = "关闭强制覆盖（恢复 OpenCode 原有选择规则）"
const DEFAULT_VARIANT = "\u0000default"

export async function configureSubagentModel(ctx: Context): Promise<void> {
  const location = currentLocation(ctx)

  const policy = await readPolicy(ctx, location)
  if (policy === undefined) return

  const models = await readModels(ctx, location)
  if (models === undefined) return

  const providers = providerNames(ctx, location)
  const current = policy.model ?? null
  const status = describeCurrent(current, models, providers)

  const choice = await ctx.ui.dialog.select<string | null>({
    title: `子代理统一模型 · 全局 — 当前：${status}`,
    placeholder: "搜索模型…",
    current: current === null ? null : baseRef(current),
    options: [
      { title: DISABLE_TITLE, value: null },
      ...models
        .map((model) => {
          const ref = modelRef(model)
          return {
            // 完整引用写进 title：宿主的默认过滤只搜 title/category，写成 footer 就搜不到完整 ID。
            title: `${model.name} — ${ref}`,
            value: ref,
            category: providerName(providers, model.providerID),
          }
        })
        .toSorted((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title)),
    ],
  })
  if (choice === undefined) return
  if (choice === null) {
    await save(ctx, location, null)
    return
  }

  const model = models.find((candidate) => modelRef(candidate) === choice)
  if (model === undefined) {
    toastError(ctx, `模型 ${choice} 已不可用，请重新选择。`)
    return
  }

  const variants = model.variants ?? []
  let variant: string | undefined
  if (variants.length > 0) {
    const picked = await ctx.ui.dialog.select<string>({
      title: `${model.name} · 选择变体`,
      placeholder: "搜索变体…",
      current: currentVariant(current, choice) ?? DEFAULT_VARIANT,
      options: [
        { title: "默认（不附加变体）", value: DEFAULT_VARIANT },
        ...variants.map((item) => ({ title: item.id, value: item.id })),
      ],
    })
    if (picked === undefined) return
    variant = picked === DEFAULT_VARIANT ? undefined : picked
  }

  await save(ctx, location, variant === undefined ? choice : `${choice}#${variant}`)
}

function currentLocation(ctx: Context): NonNullable<Context["location"]> {
  return ctx.location ?? ctx.data.location.default()
}

async function readPolicy(ctx: Context, location: Location): Promise<SubagentModelSummary | undefined> {
  let result: SubagentModelSummary
  try {
    result = await ctx.client.rpc(registryRpc).getSubagentModel({}, { location })
  } catch (error) {
    toastError(ctx, `无法读取子代理模型设置：${message(error)}`)
    return undefined
  }
  if (!result.supported) {
    toastError(ctx, "当前宿主不支持子代理模型覆盖（缺少执行前钩子），该功能不可用。")
    return undefined
  }
  if (!result.ok) {
    toastError(ctx, `无法读取子代理模型设置：${summarize(result)}`)
    return undefined
  }
  return result
}

async function readModels(ctx: Context, location: Location): Promise<ModelInfo[] | undefined> {
  try {
    const collection = ctx.data.location.model
    // `list` reads the per-location cache the host fills at boot; syncing only when it is
    // absent avoids a network hop on every open while still distinguishing "not loaded"
    // from a genuinely empty catalog.
    if (collection.list(location) === undefined) await collection.sync(location)
    const models = collection.list(location)
    if (models === undefined) throw new Error("模型目录未返回数据")
    return models.filter((model) => model.type === undefined || model.type === "chat")
  } catch (error) {
    toastError(ctx, `无法读取模型列表：${message(error)}`)
    return undefined
  }
}

function providerNames(ctx: Context, location: Location): Map<string, string> {
  const providers = ctx.data.location.provider.list(location)
  if (providers === undefined) return new Map()
  return new Map(providers.map((provider: ProviderInfo) => [provider.id, displayName(provider)]))
}

function displayName(provider: ProviderInfo): string {
  const name = provider.name?.trim()
  return name === undefined || name === "" ? provider.id : name
}

function providerName(providers: Map<string, string>, providerID: string): string {
  return providers.get(providerID) ?? providerID
}

function modelRef(model: ModelInfo): string {
  return `${model.providerID}/${model.id}`
}

function baseRef(ref: string): string {
  const variantStart = ref.indexOf("#", ref.indexOf("/") + 1)
  return variantStart === -1 ? ref : ref.slice(0, variantStart)
}

function variantOf(ref: string): string | undefined {
  const variantStart = ref.indexOf("#", ref.indexOf("/") + 1)
  return variantStart === -1 ? undefined : ref.slice(variantStart + 1)
}

function currentVariant(current: string | null, base: string): string | undefined {
  if (current === null || baseRef(current) !== base) return undefined
  return variantOf(current)
}

function describeCurrent(current: string | null, models: readonly ModelInfo[], providers: Map<string, string>): string {
  if (current === null) return "未启用"
  const model = models.find((candidate) => modelRef(candidate) === baseRef(current))
  if (model === undefined) return `${current}（当前目录不可用）`
  const variant = variantOf(current)
  const base = `${providerName(providers, model.providerID)} / ${model.name}`
  return `${variant === undefined ? base : `${base} · ${variant}`} — ${current}`
}

async function save(ctx: Context, location: Location, model: string | null): Promise<void> {
  let result: SubagentModelSummary
  try {
    result = await ctx.client.rpc(registryRpc).setSubagentModel({ model }, { location })
  } catch (error) {
    toastError(ctx, `保存子代理模型失败：${message(error)}`)
    return
  }
  if (!result.ok) {
    toastError(ctx, `保存子代理模型失败：${summarize(result)}`)
    return
  }
  ctx.ui.toast.show({
    variant: "success",
    message: model === null ? "已关闭子代理强制覆盖" : `子代理模型已设为 ${result.model ?? model}`,
  })
}

function summarize(result: SubagentModelSummary): string {
  return (result.errors ?? []).join("; ") || "未知错误"
}

function toastError(ctx: Context, message: string): void {
  ctx.ui.toast.show({ variant: "error", message })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
