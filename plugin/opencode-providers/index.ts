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
 *   - `Rpc.define` is the identity function and plain JSON Schema is accepted,
 *     so `rpc.ts` needs no `@opencode/*` either
 *
 * It registers an integration (single `key` method) and a provider
 * (`activation: "auto"`) per registry entry. Credentials are never touched:
 * opencode injects them by matching `provider.integrationID` to the integration
 * the key was stored under. No `env` method is declared on purpose — env is a
 * silent, non-interactive path and this plugin is `/connect`-only.
 *
 * The registry lives in a closure-local `state`, and both transforms read it at
 * call time, so the force-refresh RPC can populate a registry that was
 * unavailable at startup.
 */

import { buildProviderModels, buildProviderSettings } from "./registry/models.ts"
import { DEFAULT_REGISTRY_URL, loadRegistry } from "./registry/source.ts"
import type { RegistryCacheEntry, RegistryStore } from "./registry/source.ts"
import type { Registry } from "./registry/schema.ts"
import { registryRpc, type RefreshSummary } from "./rpc.ts"

const PLUGIN_ID = "opencode-providers"

/** Tags integrations so the TUI entry can recognise its own (TUI side keeps its own copy of this string). */
const INTEGRATION_SOURCE = PLUGIN_ID

/**
 * Background revalidation cadence. `loadRegistry` (no `force`) still gates the
 * network on the 6h TTL; this only decides how often we *check*, so a stale
 * cache is refreshed within one interval of expiring instead of only on the next
 * plugin load (opencode start / plugin install / config reload / service restart).
 * Overridable via `options.refreshIntervalMs` (tests / forks); a non-positive
 * value disables the timer.
 */
const DEFAULT_REFRESH_INTERVAL_MS = 30 * 60 * 1000

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
  readonly integration: {
    transform(callback: (editor: IntegrationEditorLike) => void): Promise<unknown>
    reload(): Promise<unknown>
  }
  readonly provider: {
    transform(callback: (editor: ProviderEditorLike) => void): Promise<unknown>
    reload(): Promise<unknown>
  }
  /** Absent on hosts/versions without the RPC domain; force refresh then degrades to unavailable. */
  readonly rpc?: {
    register(
      definition: unknown,
      handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>>,
    ): Promise<unknown>
  }
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
    const store: RegistryStore = {
      get: async () => asCacheEntry(await ctx.storage.get(cacheKey)),
      set: async (entry) => {
        await ctx.storage.set(cacheKey, entry)
      },
    }

    // Closure-local: repeated `setup` calls (config hot reload) must not share state.
    const state: { registry?: Registry } = {}

    // Swap the closure state and re-run the transforms. Registration is a full
    // replace, so entries removed upstream also disappear on the next apply.
    const applyRegistry = async (registry: Registry): Promise<void> => {
      state.registry = registry
      await ctx.integration.reload()
      await ctx.provider.reload()
    }

    // Force refresh: bypass the TTL, re-register, and tell the TUI what it got.
    // A `stale-cache` result means upstream was unreachable, so it counts as a
    // failure and leaves `state` (and the registered providers) untouched.
    const refresh = async (): Promise<RefreshSummary> => {
      const result = await loadRegistry({ url, fetch: globalThis.fetch, store, force: true })
      if (!result.ok) return { ok: false, errors: [...result.errors] }
      if (result.source === "stale-cache") {
        return { ok: false, errors: ["registry refresh failed; serving the cached copy"] }
      }
      await applyRegistry(result.registry)
      return {
        ok: true,
        providers: Object.keys(result.registry.providers).length,
        models: countModels(result.registry),
        source: result.source,
        fetchedAt: result.fetchedAt,
      }
    }

    try {
      await ctx.rpc?.register(registryRpc, { refresh })
    } catch (error) {
      // Refresh being unavailable must never block provider registration.
      console.warn(
        `[${PLUGIN_ID}] rpc refresh unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const result = await loadRegistry({ url, fetch: globalThis.fetch, store })
    if (!result.ok) {
      console.error(`[${PLUGIN_ID}] registry unavailable (${url}): ${result.errors.join("; ")}`)
    } else {
      if (result.source === "stale-cache") {
        console.warn(
          `[${PLUGIN_ID}] registry refresh failed; serving cache from ${new Date(result.fetchedAt).toISOString()}`,
        )
      }
      if (result.warnings.length > 0) {
        console.warn(`[${PLUGIN_ID}] skipped registry entries: ${result.warnings.join("; ")}`)
      }
      state.registry = result.registry
    }

    // Always register both transforms (no-op while `state.registry` is empty), so a
    // later force refresh can recover from a registry that was unavailable at boot.
    await ctx.integration.transform((editor) => {
      const registry = state.registry
      if (registry === undefined) return
      for (const [id, provider] of Object.entries(registry.providers)) {
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
      const registry = state.registry
      if (registry === undefined) return
      for (const [id, provider] of Object.entries(registry.providers)) {
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

    // Background revalidation. A non-force load runs the same TTL check the boot
    // path used; only a real content change (`source === "network"`) re-registers,
    // so an unchanged registry never nudges `provider.reload()` and `/models` does
    // not flap. A failed check keeps the current registration and retries next tick,
    // so a registry that was unavailable at boot recovers without a restart.
    const intervalMs =
      typeof ctx.options.refreshIntervalMs === "number" ? ctx.options.refreshIntervalMs : DEFAULT_REFRESH_INTERVAL_MS
    let timer: ReturnType<typeof setInterval> | undefined
    if (intervalMs > 0) {
      let ticking = false
      const tick = async (): Promise<void> => {
        if (ticking) return
        ticking = true
        try {
          const result = await loadRegistry({ url, fetch: globalThis.fetch, store })
          if (!result.ok || result.source !== "network") return
          await applyRegistry(result.registry)
        } catch (error) {
          console.warn(
            `[${PLUGIN_ID}] background registry refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        } finally {
          ticking = false
        }
      }
      timer = setInterval(() => void tick(), intervalMs)
      // Never keep the process alive for this: the service owns an HTTP listener,
      // and an uncleared timer would otherwise hang `node --test`.
      unrefTimer(timer)
    }

    // Teardown: the host runs this on unload / hot reload / location close, so a
    // reloaded plugin never leaves an orphaned interval behind.
    return () => {
      if (timer !== undefined) clearInterval(timer)
    }
  },
}

function countModels(registry: Registry): number {
  let total = 0
  for (const provider of Object.values(registry.providers)) total += Object.keys(provider.models).length
  return total
}

/** Detach a timer from the event loop where the runtime supports it (Node/Bun). */
function unrefTimer(timer: unknown): void {
  if (typeof timer !== "object" || timer === null) return
  const unref = (timer as { unref?: unknown }).unref
  if (typeof unref === "function") (unref as () => void).call(timer)
}

function asCacheEntry(value: unknown): RegistryCacheEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const entry = value as Partial<RegistryCacheEntry>
  if (typeof entry.fetchedAt !== "number" || typeof entry.body !== "string") return undefined
  if (entry.etag !== undefined && typeof entry.etag !== "string") return undefined
  if (entry.revision !== undefined && typeof entry.revision !== "string") return undefined
  return entry as RegistryCacheEntry
}