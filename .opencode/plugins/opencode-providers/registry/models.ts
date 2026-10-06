/**
 * Maps validated registry entries onto plain `Model.Info`-shaped objects.
 *
 * Pure and dependency-free so `node --test` can cover it without the OpenCode
 * runtime. The server entry feeds the result straight to `ctx.provider.transform`.
 */

import type { ProviderEntry, Registry } from "./schema.ts"
import { resolveModelSpec } from "./schema.ts"

export interface ModelInfoLike {
  readonly id: string
  readonly modelID: string
  readonly providerID: string
  readonly name: string
  readonly family?: string
  readonly compatibility?: Readonly<Record<string, unknown>>
  readonly capabilities: {
    readonly tools: boolean
    readonly input: readonly string[]
    readonly output: readonly string[]
  }
  readonly variants: ReadonlyArray<{ readonly id: string; readonly settings?: Readonly<Record<string, unknown>> }>
  readonly time: { readonly released: number }
  readonly cost: ReadonlyArray<{
    readonly input: number
    readonly output: number
    readonly cache: { readonly read: number; readonly write: number }
  }>
  readonly status: "alpha" | "beta" | "deprecated" | "active"
  readonly enabled: boolean
  readonly limit: { readonly context: number; readonly input?: number; readonly output: number }
}

export function buildProviderModels(
  registry: Registry,
  providerID: string,
  provider: ProviderEntry,
): ModelInfoLike[] {
  const models: ModelInfoLike[] = []

  for (const [id, spec] of Object.entries(provider.models)) {
    const resolved = resolveModelSpec(registry, spec)
    if (resolved === undefined) continue

    const compatibility: Record<string, unknown> = {}
    if (resolved.reasoningField !== undefined) compatibility.reasoningField = resolved.reasoningField
    if (resolved.maxTokensField !== undefined) compatibility.maxTokensField = resolved.maxTokensField

    models.push({
      id,
      modelID: spec.modelID ?? id,
      providerID,
      name: resolved.name ?? id,
      ...(resolved.family === undefined ? {} : { family: resolved.family }),
      ...(Object.keys(compatibility).length === 0 ? {} : { compatibility }),
      capabilities: {
        tools: resolved.tools ?? true,
        input: resolved.input ?? ["text"],
        output: resolved.output ?? ["text"],
      },
      variants: (resolved.variants ?? []).map((variant) =>
        variant.settings === undefined ? { id: variant.id } : { id: variant.id, settings: variant.settings },
      ),
      time: { released: resolveReleased(resolved.releaseDate) },
      cost:
        resolved.cost === undefined
          ? []
          : [
              {
                input: resolved.cost.input,
                output: resolved.cost.output,
                cache: { read: resolved.cost.cache_read ?? 0, write: resolved.cost.cache_write ?? 0 },
              },
            ],
      status: resolved.status ?? "active",
      enabled: resolved.disabled !== true,
      limit: {
        context: resolved.limit.context,
        ...(resolved.limit.input === undefined ? {} : { input: resolved.limit.input }),
        output: resolved.limit.output,
      },
    })
  }

  return models
}

/** Provider settings = registry `settings` layered over `{ baseURL }`. */
export function buildProviderSettings(provider: ProviderEntry): Readonly<Record<string, unknown>> | undefined {
  if (provider.baseURL === undefined && provider.settings === undefined) return undefined
  return { ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }), ...provider.settings }
}

function resolveReleased(releaseDate: string | undefined): number {
  if (releaseDate === undefined) return 0
  const parsed = Date.parse(releaseDate)
  return Number.isFinite(parsed) ? parsed : 0
}
