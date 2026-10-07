/**
 * Server entry — registers providers from the registry.
 *
 * IMPORTANT: this file deliberately imports **nothing** from `@opencode/*`.
 * A locally installed server plugin does not get the plugin module injected
 * (opencode 2.0.24 fails with `Cannot find package '@opencode/plugin'`), unlike
 * `@opencode/plugin/tui` for TUI entries. Everything the runtime needs here is a
 * plain value:
 *   - `Plugin.define` is the identity function, so a default export is enough
 *   - `Provider.ID.make` / `Integration.ID.make` are identity at runtime
 *   - `Provider.Info.empty(id)` is `{ id, name: id, activation: "auto", package: "" }`
 *     and every field is overridden below anyway
 *
 * It registers an integration (single `key` method) and a provider
 * (`activation: "auto"`) per registry entry. Credentials are never touched:
 * opencode injects them by matching `provider.integrationID` to the integration
 * the key was stored under. No `env` method is declared on purpose — env is a
 * silent, non-interactive path and this plugin is `/connect`-only.
 */

import { buildProviderModels, buildProviderSettings } from "./registry/models.ts"
import { DEFAULT_REGISTRY_URL, loadRegistry } from "./registry/source.ts"
import type { RegistryCacheEntry } from "./registry/source.ts"

const PLUGIN_ID = "opencode-providers"

/** Tags integrations so the TUI entry can recognise its own (TUI side keeps its own copy of this string). */
const INTEGRATION_SOURCE = PLUGIN_ID

interface IntegrationRefLike {
  id: string
  name: string
}

interface IntegrationEditorLike {
  update(id: string, update: (integration: IntegrationRefLike) => void): void
  method: { update(input: { integrationID: string; method: { type: "key"; label?: string } }): void }
}

interface ProviderEditorLike {
  add(input: { info: Record<string, unknown>; models: readonly Record<string, unknown>[] }): void
}

/** Only the members this plugin uses; see the file comment for why it is structural. */
interface SetupContextLike {
  readonly options: Readonly<Record<string, unknown>>
  readonly storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
  }
  readonly integration: { transform(callback: (editor: IntegrationEditorLike) => void): Promise<unknown> }
  readonly provider: { transform(callback: (editor: ProviderEditorLike) => void): Promise<unknown> }
}

export default {
  id: PLUGIN_ID,
  async setup(ctx: SetupContextLike) {
    // NOTE: discovered directory plugins are registered with `options: {}`, so this override is only
    // reachable through a config `plugins` entry (which we deliberately do not use for TUI plugins).
    // It exists for tests and forks; script installs always use DEFAULT_REGISTRY_URL.
    const url = typeof ctx.options.registryUrl === "string" ? ctx.options.registryUrl : DEFAULT_REGISTRY_URL
    // Cache per URL: switching the registry URL must not keep serving the old body for a TTL.
    const cacheKey = `registry-cache:${url}`
    const result = await loadRegistry({
      url,
      fetch: globalThis.fetch,
      store: {
        get: async () => asCacheEntry(await ctx.storage.get(cacheKey)),
        set: async (entry) => {
          await ctx.storage.set(cacheKey, entry)
        },
      },
    })

    if (!result.ok) {
      console.error(`[${PLUGIN_ID}] registry unavailable (${url}): ${result.errors.join("; ")}`)
      return
    }
    if (result.source === "stale-cache") {
      console.warn(
        `[${PLUGIN_ID}] registry refresh failed; serving cache from ${new Date(result.fetchedAt).toISOString()}`,
      )
    }

    const { registry } = result
    const entries = Object.entries(registry.providers)

    await ctx.integration.transform((editor) => {
      for (const [id, provider] of entries) {
        editor.update(id, (integration) => {
          integration.name = provider.name
          // `metadata` is part of the integration ref and surfaces in `Integration.Info`,
          // but the plugin-facing ref type only declares id/name.
          ;(integration as IntegrationRefLike & { metadata?: Record<string, unknown> }).metadata = {
            source: INTEGRATION_SOURCE,
            ...(provider.keyLabel === undefined ? {} : { keyLabel: provider.keyLabel }),
          }
        })
        editor.method.update({
          integrationID: id,
          method: { type: "key", label: provider.keyLabel ?? "Paste API key" },
        })
      }
    })

    await ctx.provider.transform((editor) => {
      for (const [id, provider] of entries) {
        const models = buildProviderModels(registry, id, provider)
        if (models.length === 0) continue
        const settings = buildProviderSettings(provider)
        editor.add({
          info: {
            id,
            name: provider.name,
            activation: "auto",
            integrationID: id,
            package: provider.package,
            ...(settings === undefined ? {} : { settings }),
            ...(provider.headers === undefined ? {} : { headers: provider.headers }),
          },
          models,
        })
      }
    })
  },
}

function asCacheEntry(value: unknown): RegistryCacheEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const entry = value as Partial<RegistryCacheEntry>
  if (typeof entry.fetchedAt !== "number" || typeof entry.body !== "string") return undefined
  if (entry.etag !== undefined && typeof entry.etag !== "string") return undefined
  return entry as RegistryCacheEntry
}
