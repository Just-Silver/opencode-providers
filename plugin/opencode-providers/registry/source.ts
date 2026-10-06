/**
 * Registry loading: fetch + TTL + ETag + stale fallback.
 *
 * Pure logic with injected `fetch` / clock / cache so `node --test` can cover
 * the failure paths. The server entry wires these to `ctx.storage` and the
 * process `fetch`.
 */

import type { Registry } from "./schema.ts"
import { parseRegistry } from "./schema.ts"

export const DEFAULT_REGISTRY_URL =
  "https://raw.githubusercontent.com/Just-Silver/opencode-providers/main/registry/registry.json"

/** Successful checks are trusted for 6h; a failed refresh keeps serving the cached copy. */
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000
export const DEFAULT_TIMEOUT_MS = 10_000

export interface RegistryCacheEntry {
  readonly etag?: string
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
}

export type RegistrySource = "cache" | "network" | "stale-cache"

export type LoadRegistryResult =
  | { readonly ok: true; readonly registry: Registry; readonly source: RegistrySource; readonly fetchedAt: number }
  | { readonly ok: false; readonly errors: readonly string[] }

const isCacheEntry = (value: unknown): value is RegistryCacheEntry =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as RegistryCacheEntry).fetchedAt === "number" &&
  typeof (value as RegistryCacheEntry).body === "string" &&
  ((value as RegistryCacheEntry).etag === undefined || typeof (value as RegistryCacheEntry).etag === "string")

export async function loadRegistry(options: LoadRegistryOptions): Promise<LoadRegistryResult> {
  const url = options.url ?? DEFAULT_REGISTRY_URL
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const cached = await readCache(options.store)

  if (cached !== undefined && now() - cached.fetchedAt < ttlMs) {
    const parsed = parseBody(cached.body)
    if (parsed.ok) return { ok: true, registry: parsed.registry, source: "cache", fetchedAt: cached.fetchedAt }
  }

  let response: Response
  try {
    response = await options.fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "opencode-providers",
        ...(cached?.etag === undefined ? {} : { "if-none-match": cached.etag }),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return fallback(cached, errorMessage(error))
  }

  if (response.status === 304 && cached !== undefined) {
    const entry = { ...cached, fetchedAt: now() }
    await writeCache(options.store, entry)
    const parsed = parseBody(cached.body)
    if (parsed.ok) return { ok: true, registry: parsed.registry, source: "cache", fetchedAt: entry.fetchedAt }
    return { ok: false, errors: parsed.errors }
  }

  if (!response.ok) return fallback(cached, `registry request failed: ${response.status} ${response.statusText}`)

  let body: string
  try {
    body = await response.text()
  } catch (error) {
    return fallback(cached, errorMessage(error))
  }

  const parsed = parseBody(body)
  if (!parsed.ok) {
    const stale = await staleFallback(cached, parsed.errors)
    if (stale !== undefined) return stale
    return { ok: false, errors: parsed.errors }
  }

  const etag = response.headers.get("etag") ?? undefined
  const fetchedAt = now()
  await writeCache(options.store, { ...(etag === undefined ? {} : { etag }), fetchedAt, body })
  return { ok: true, registry: parsed.registry, source: "network", fetchedAt }
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
  return { ok: true, registry: parsed.registry, source: "stale-cache", fetchedAt: cached.fetchedAt }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
