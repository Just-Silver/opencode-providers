/**
 * Split-registry aggregation.
 *
 * The registry source is spread across `providers/<id>/{provider,models}.json`
 * and `models/<lab>/<model>.json`; the plugin pulls the manifest, then every
 * child file, and reassembles one `Registry`-shaped object for `parseRegistry`.
 *
 * Dependency-free and runtime-agnostic on purpose: the server entry, the TUI
 * entry and `node --test` all import this module, so it must not touch
 * `@opencode/*`, JSX or Node built-ins. Reads are injected so tests can fake
 * the network.
 */

import { SUPPORTED_SCHEMA_VERSION, parseRegistry } from "./schema.ts"

export interface Manifest {
  readonly schemaVersion: number
  readonly revision: string
  readonly providers: readonly string[]
}

export type ParseManifestResult =
  | { readonly ok: true; readonly manifest: Manifest }
  | { readonly ok: false; readonly errors: readonly string[] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function parseManifest(input: unknown): ParseManifestResult {
  const errors: string[] = []
  if (!isRecord(input)) return { ok: false, errors: ["manifest: must be an object"] }

  if (input.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion: unsupported value ${JSON.stringify(input.schemaVersion)} (this plugin supports ${SUPPORTED_SCHEMA_VERSION})`,
    )
  }
  if (typeof input.revision !== "string" || !input.revision) errors.push("revision: must be a non-empty string")

  let providers: string[] = []
  if (!Array.isArray(input.providers) || !input.providers.every((id) => typeof id === "string" && id.length > 0)) {
    errors.push("providers: must be an array of non-empty strings")
  } else {
    providers = input.providers as string[]
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    manifest: { schemaVersion: SUPPORTED_SCHEMA_VERSION, revision: input.revision as string, providers },
  }
}

export interface AggregatedRegistry {
  readonly schemaVersion: number
  readonly models: Record<string, unknown>
  readonly providers: Record<string, Record<string, unknown>>
}

export type BuildRegistryResult =
  | { readonly ok: true; readonly registry: AggregatedRegistry; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[]; readonly warnings: readonly string[] }

/** Extracts the `base` references a provider's models declare. */
function basesOf(models: Record<string, unknown>): string[] {
  const bases: string[] = []
  for (const spec of Object.values(models)) {
    if (isRecord(spec) && typeof spec.base === "string" && spec.base) bases.push(spec.base)
  }
  return bases
}

/**
 * Fetches every provider + referenced shared model, validates each provider in
 * isolation, and skips the ones that fail (a single bad provider must not
 * poison the rest). Returns `ok:false` only when no provider survives.
 */
export async function buildRegistry(
  manifest: Manifest,
  readJson: (relativePath: string) => Promise<unknown>,
): Promise<BuildRegistryResult> {
  const warnings: string[] = []

  const loaded = new Map<string, { provider: Record<string, unknown>; models: Record<string, unknown> }>()
  await Promise.all(
    manifest.providers.map(async (id) => {
      try {
        const provider = await readJson(`providers/${id}/provider.json`)
        if (!isRecord(provider)) {
          warnings.push(`${id}: provider.json must be an object`)
          return
        }
        const models = await readJson(`providers/${id}/models.json`)
        if (!isRecord(models)) {
          warnings.push(`${id}: models.json must be an object`)
          return
        }
        loaded.set(id, { provider, models })
      } catch (error) {
        warnings.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }),
  )

  const bases = new Set<string>()
  for (const entry of loaded.values()) for (const base of basesOf(entry.models)) bases.add(base)

  const fetched: Record<string, unknown> = {}
  await Promise.all(
    [...bases].map(async (base) => {
      try {
        const model = await readJson(`models/${base}.json`)
        if (!isRecord(model)) {
          warnings.push(`shared model ${base}: must be an object`)
          return
        }
        fetched[base] = model
      } catch (error) {
        warnings.push(`shared model ${base}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }),
  )

  // Keep only shared models that pass the schema on their own, so the final
  // aggregate cannot be rejected by one malformed shared file.
  const shared: Record<string, unknown> = {}
  for (const [base, model] of Object.entries(fetched)) {
    const probe = parseRegistry({
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      models: { [base]: model },
      providers: { __probe__: { name: "probe", package: "probe", models: { probe: { base } } } },
    })
    if (probe.ok) shared[base] = model
    else warnings.push(`shared model ${base}: ${probe.errors.join("; ")}`)
  }

  const providers: Record<string, Record<string, unknown>> = {}
  for (const id of manifest.providers) {
    const entry = loaded.get(id)
    if (!entry) continue

    const candidateModels: Record<string, unknown> = {}
    for (const base of basesOf(entry.models)) if (base in shared) candidateModels[base] = shared[base]

    const candidate = {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      models: candidateModels,
      providers: { [id]: { ...entry.provider, models: entry.models } },
    }
    const parsed = parseRegistry(candidate)
    if (!parsed.ok) {
      warnings.push(`${id}: ${parsed.errors.join("; ")}`)
      continue
    }
    providers[id] = { ...entry.provider, models: entry.models }
  }

  if (Object.keys(providers).length === 0) {
    return { ok: false, errors: ["no providers could be loaded"], warnings }
  }
  return { ok: true, registry: { schemaVersion: SUPPORTED_SCHEMA_VERSION, models: shared, providers }, warnings }
}