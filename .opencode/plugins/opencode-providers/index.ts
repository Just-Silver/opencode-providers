/**
 * Server entry — the only place that touches `ctx.integration` / `ctx.provider`.
 *
 * Loads the registry (TTL + ETag + stale fallback) and registers, for every
 * provider in it:
 *   - an integration with a single `key` method, so it shows up in `/connect`
 *   - a provider (`activation: "auto"`) with its models
 *
 * Credentials are never touched here: opencode resolves them by matching
 * `provider.integrationID` to the integration the key was stored under.
 * No `env` method is declared on purpose — env is a silent, non-interactive
 * path and this plugin is `/connect`-only.
 */

import { Integration, Plugin, Provider } from "@opencode/plugin"
import { buildProviderModels, buildProviderSettings } from "./registry/models.ts"
import { DEFAULT_REGISTRY_URL, loadRegistry } from "./registry/source.ts"
import type { RegistryCacheEntry } from "./registry/source.ts"

const PLUGIN_ID = "opencode-providers"
const CACHE_KEY = "registry-cache"

/** Tags integrations so the TUI entry can recognise its own. */
export const INTEGRATION_SOURCE = PLUGIN_ID

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const url = typeof ctx.options.registryUrl === "string" ? ctx.options.registryUrl : DEFAULT_REGISTRY_URL
    const result = await loadRegistry({
      url,
      fetch: globalThis.fetch,
      store: {
        get: async () => asCacheEntry(await ctx.storage.get(CACHE_KEY)),
        set: async (entry) => {
          await ctx.storage.set(CACHE_KEY, entry as unknown as Parameters<typeof ctx.storage.set>[1])
        },
      },
    })

    if (!result.ok) {
      console.error(`[${PLUGIN_ID}] registry unavailable (${url}): ${result.errors.join("; ")}`)
      return
    }
    if (result.source === "stale-cache") {
      console.warn(`[${PLUGIN_ID}] registry refresh failed; serving cache from ${new Date(result.fetchedAt).toISOString()}`)
    }

    const { registry } = result
    const entries = Object.entries(registry.providers)

    await ctx.integration.transform((editor) => {
      for (const [id, provider] of entries) {
        editor.update(id, (integration) => {
          integration.name = provider.name
          // `metadata` is part of the registry ref and surfaces in `Integration.Info`,
          // but the plugin-facing `IntegrationRef` type only declares id/name.
          ;(integration as { metadata?: Record<string, unknown> }).metadata = {
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
            ...Provider.Info.empty(Provider.ID.make(id)),
            name: provider.name,
            activation: "auto",
            integrationID: Integration.ID.make(id),
            package: provider.package,
            ...(settings === undefined ? {} : { settings }),
            ...(provider.headers === undefined ? {} : { headers: provider.headers }),
          },
          // Structurally a `Model.Info`; the local shape exists only for testing.
          models,
        } as never)
      }
    })
  },
})

function asCacheEntry(value: unknown): RegistryCacheEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const entry = value as Partial<RegistryCacheEntry>
  if (typeof entry.fetchedAt !== "number" || typeof entry.body !== "string") return undefined
  if (entry.etag !== undefined && typeof entry.etag !== "string") return undefined
  return entry as RegistryCacheEntry
}
