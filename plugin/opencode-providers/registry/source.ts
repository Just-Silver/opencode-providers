/**
 * Registry loading: manifest fetch + TTL + ETag + revision short-circuit +
 * force refresh + stale fallback.
 *
 * The remote source is split across many files (`index.json` manifest +
 * `providers/**` + `models/**`); this module fetches the manifest, and only
 * when its `revision` moved does it pull the child files through
 * `buildRegistry`. The cache holds the *aggregated* body, so downstream
 * (`parseRegistry`, `models.ts`) is unchanged.
 *
 * Pure logic with injected `fetch` / clock / cache so `node --test` can cover
 * the failure paths. The server entry wires these to `ctx.storage` and the
 * process `fetch`.
 */

import { buildRegistry, parseManifest } from "./aggregate.ts"
import type { Registry } from "./schema.ts"
import { parseRegistry } from "./schema.ts"

export const DEFAULT_REGISTRY_URL =
  "https://raw.githubusercontent.com/Just-Silver/opencode-providers/main/registry/index.json"

/** Successful checks are trusted for 6h; a failed refresh keeps serving the cached copy. */
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 10_000

export interface RegistryCacheEntry {
  readonly etag?: string
  /** Manifest revision the cached body was built from. */
  readonly revision?: string
  readonly fetchedAt: number
  readonly body: string
}

export interface RegistryStore {
  get(): Promise<RegistryCacheEntry | undefined>
  set(entry: RegistryCacheEntry): Promise<void>
}

export interface LoadRegistryOptions {
  readonly store: RegistryStore
  readonly fetch: typeof globalThis.fetch
  /** Defaults to `DEFAULT_REGISTRY_URL`. */
  readonly url?: string
  readonly now?: () => number
  readonly ttlMs?: number
  readonly timeoutMs?: number
  /** Bypass the TTL and revalidate now (used by force refresh). */
  readonly force?: boolean
}

export type RegistrySource = "cache" | "network" | "stale-cache"

export type LoadRegistryResult =
  | {
      readonly ok: true
      readonly registry: Registry
      readonly source: RegistrySource
      readonly fetchedAt: number
      readonly warnings: readonly string[]
    }
  | { readonly ok: false; readonly errors: readonly string[] }

const isCacheEntry = (value: unknown): value is RegistryCacheEntry =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as RegistryCacheEntry).fetchedAt === "number" &&
  typeof (value as RegistryCacheEntry).body === "string" &&
  ((value as RegistryCacheEntry).etag === undefined || typeof (value as RegistryCacheEntry).etag === "string") &&
  ((value as RegistryCacheEntry).revision === undefined || typeof (value as RegistryCacheEntry).revision === "string")

export async function loadRegistry(options: LoadRegistryOptions): Promise<LoadRegistryResult> {
  const url = options.url ?? DEFAULT_REGISTRY_URL
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const cached = await readCache(options.store)

  if (!options.force && cached !== undefined && now() - cached.fetchedAt < ttlMs) {
    const parsed = parseBody(cached.body)
    if (parsed.ok) return success(parsed.registry, "cache", cached.fetchedAt)
  }

  let manifestBody: string
  let manifestEtag: string | undefined
  try {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "opencode-providers" }
    if (cached?.etag !== undefined) headers["if-none-match"] = cached.etag

    const response = await options.fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })

    if (response.status === 304 && cached !== undefined) {
      const parsed = parseBody(cached.body)
      if (parsed.ok) {
        const entry = { ...cached, fetchedAt: now() }
        await writeCache(options.store, entry)
        return success(parsed.registry, "cache", entry.fetchedAt)
      }
      // The cached body is unusable: we cannot rebuild from an empty 304, so
      // refetch the manifest unconditionally (RF2).
      const unconditional = await options.fetch(url, {
        headers: { accept: "application/json", "user-agent": "opencode-providers" },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!unconditional.ok)
        return fallback(cached, `registry request failed: ${unconditional.status} ${unconditional.statusText}`)
      manifestBody = await unconditional.text()
      manifestEtag = unconditional.headers.get("etag") ?? undefined
    } else if (response.ok) {
      manifestBody = await response.text()
      manifestEtag = response.headers.get("etag") ?? undefined
    } else {
      return fallback(cached, `registry request failed: ${response.status} ${response.statusText}`)
    }
  } catch (error) {
    return fallback(cached, errorMessage(error))
  }

  let manifestInput: unknown
  try {
    manifestInput = JSON.parse(manifestBody)
  } catch (error) {
    const errors = [`registry manifest is not valid JSON: ${errorMessage(error)}`]
    const stale = await staleFallback(cached, errors)
    return stale ?? { ok: false, errors }
  }

  const manifest = parseManifest(manifestInput)
  if (!manifest.ok) {
    const stale = await staleFallback(cached, manifest.errors)
    return stale ?? { ok: false, errors: [...manifest.errors] }
  }

  // Short-circuit: same revision and a healthy cached aggregate → no child
  // fetches. A corrupt cached body falls through and is rebuilt.
  if (cached !== undefined && cached.revision !== undefined && cached.revision === manifest.manifest.revision) {
    const parsed = parseBody(cached.body)
    if (parsed.ok) {
      const entry = {
        ...cached,
        ...(manifestEtag === undefined ? {} : { etag: manifestEtag }),
        fetchedAt: now(),
      }
      await writeCache(options.store, entry)
      return success(parsed.registry, "cache", entry.fetchedAt)
    }
  }

  const built = await buildRegistry(manifest.manifest, async (relativePath) => {
    const childUrl = new URL(relativePath, url).toString()
    const response = await options.fetch(childUrl, {
      headers: { accept: "application/json", "user-agent": "opencode-providers" },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`registry request failed: ${response.status} ${response.statusText}`)
    return JSON.parse(await response.text())
  })

  if (!built.ok) {
    const stale = await staleFallback(cached, built.errors)
    return stale ?? { ok: false, errors: [...built.errors] }
  }

  const fetchedAt = now()
  await writeCache(options.store, {
    ...(manifestEtag === undefined ? {} : { etag: manifestEtag }),
    revision: manifest.manifest.revision,
    fetchedAt,
    body: JSON.stringify(built.registry),
  })
  return success(built.registry, "network", fetchedAt, built.warnings)
}

function success(
  registry: Registry,
  source: RegistrySource,
  fetchedAt: number,
  warnings: readonly string[] = [],
): LoadRegistryResult {
  return { ok: true, registry, source, fetchedAt, warnings }
}

/** A cache-write failure must never break loading; the payload is served regardless. */
async function writeCache(store: RegistryStore, entry: RegistryCacheEntry): Promise<void> {
  try {
    await store.set(entry)
  } catch {
    // intentionally ignored
  }
}

async function readCache(store: RegistryStore): Promise<RegistryCacheEntry | undefined> {
  try {
    const value = await store.get()
    return isCacheEntry(value) ? value : undefined
  } catch {
    return undefined
  }
}

function parseBody(body: string): { ok: true; registry: Registry } | { ok: false; errors: string[] } {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch (error) {
    return { ok: false, errors: [`registry is not valid JSON: ${errorMessage(error)}`] }
  }
  const parsed = parseRegistry(json)
  return parsed.ok ? { ok: true, registry: parsed.registry } : { ok: false, errors: [...parsed.errors] }
}

async function fallback(cached: RegistryCacheEntry | undefined, reason: string): Promise<LoadRegistryResult> {
  const stale = await staleFallback(cached, [reason])
  return stale ?? { ok: false, errors: [reason] }
}

async function staleFallback(
  cached: RegistryCacheEntry | undefined,
  errors: readonly string[],
): Promise<LoadRegistryResult | undefined> {
  if (cached === undefined) return undefined
  const parsed = parseBody(cached.body)
  if (!parsed.ok) return undefined
  return { ok: true, registry: parsed.registry, source: "stale-cache", fetchedAt: cached.fetchedAt, warnings: [] }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}