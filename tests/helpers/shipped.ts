/**
 * 随仓注册表的**只读**动态视图：测试的期望值一律从这里推导，不写死任何供应商 / 模型 / 共享模型。
 *
 * 目的：新增或删除供应商、模型、顶层共享模型（也就是 skills 的日常操作）时，
 * **不需要改任何测试代码**。测试只钉「注册表里有什么就反映什么」。
 *
 * 只读、不写盘：`root` 可以是随仓 `registry/`，也可以是测试复制到临时目录的副本。
 *
 * 用闭包工厂而不是 class：Node 原生 TS 只做类型擦除，class 的成员修饰符（`private`）会解析失败。
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

export interface ModelSpec {
  name?: string
  modelID?: string
  limit?: { context: number; output: number }
  variants?: { id: string; settings?: Record<string, unknown> }[]
  base?: string
  input?: string[]
}

export interface ProviderSpec {
  name: string
  package?: string
  baseURL?: string
  keyLabel?: string
}

export interface BasedModel {
  id: string
  key: string
  spec: ModelSpec
}

/** 取不到必需的锚点时立刻报错，而不是让断言拿着 `undefined` 报出误导性的失败。 */
export function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`注册表里找不到${what}；该测试需要一个真实存在的数据作为锚点`)
  }
  return value
}

export function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function registryView(root: string) {
  const read = (rel: string): unknown =>
    JSON.parse(readFileSync(join(root, ...rel.split("/")), "utf8"))

  /** 全部供应商 id（来自 `providers/<id>/` 目录，已排序）。 */
  const ids = (): string[] =>
    readdirSync(join(root, "providers"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

  const provider = (id: string): ProviderSpec => read(`providers/${id}/provider.json`) as ProviderSpec

  const models = (id: string): Record<string, ModelSpec> =>
    read(`providers/${id}/models.json`) as Record<string, ModelSpec>

  const keys = (id: string): string[] => Object.keys(models(id))

  /** 顶层共享模型：ref（`<lab>/<model>`）→ spec。 */
  const shared = (): Record<string, ModelSpec> => {
    const out: Record<string, ModelSpec> = {}
    let labs: string[]
    try {
      labs = readdirSync(join(root, "models"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return out // 没有 models/ 层也是合法状态
    }
    for (const lab of labs) {
      for (const name of readdirSync(join(root, "models", lab)).sort()) {
        if (!name.endsWith(".json")) continue
        out[`${lab}/${name.slice(0, -".json".length)}`] = read(`models/${lab}/${name}`) as ModelSpec
      }
    }
    return out
  }

  const sharedRefs = (): string[] => Object.keys(shared()).sort()

  const sharedSpec = (ref: string): ModelSpec => need(shared()[ref], `共享模型 ${ref}`)

  /** 引用了顶层共享模型的 provider 模型。 */
  const basedModels = (): BasedModel[] => {
    const out: BasedModel[] = []
    for (const id of ids()) {
      for (const [key, spec] of Object.entries(models(id))) {
        if (typeof spec.base === "string" && spec.base) out.push({ id, key, spec })
      }
    }
    return out
  }

  /** 被引用的共享 ref → 引用它的供应商 id 列表。 */
  const referenced = (): Map<string, string[]> => {
    const out = new Map<string, string[]>()
    for (const { id, spec } of basedModels()) {
      const ref = spec.base!
      out.set(ref, [...(out.get(ref) ?? []), id])
    }
    return out
  }

  const modelCount = (): number => ids().reduce((total, id) => total + keys(id).length, 0)

  const sharedCount = (): number => sharedRefs().length

  /** 带 `baseURL` 的供应商（baseURL 占用冲突的测试需要）。 */
  const providerWithBaseURL = (): { id: string; baseURL: string } => {
    for (const id of ids()) {
      const baseURL = provider(id).baseURL
      if (baseURL) return { id, baseURL }
    }
    throw new Error("注册表里没有任何带 baseURL 的供应商")
  }

  /** 只写了 `base` 的 provider 模型（`--unset base` 后应当只剩内联字段）。 */
  const baseOnlyModel = (): { id: string; key: string; ref: string } | undefined => {
    for (const { id, key, spec } of basedModels()) {
      if (Object.keys(spec).length === 1) return { id, key, ref: spec.base! }
    }
    return undefined
  }

  /** 覆盖了发往上游的真实 modelID 的 provider 模型。 */
  const modelWithModelIDOverride = (): { id: string; key: string; modelID: string } | undefined => {
    for (const id of ids()) {
      for (const [key, spec] of Object.entries(models(id))) {
        if (spec.modelID !== undefined && spec.modelID !== key) return { id, key, modelID: spec.modelID }
      }
    }
    return undefined
  }

  return {
    root,
    ids,
    provider,
    models,
    keys,
    shared,
    sharedRefs,
    sharedSpec,
    basedModels,
    referenced,
    modelCount,
    sharedCount,
    providerWithBaseURL,
    baseOnlyModel,
    modelWithModelIDOverride,
  }
}

export type RegistryView = ReturnType<typeof registryView>