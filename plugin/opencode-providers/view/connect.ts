/**
 * `/connect-providers` flow.
 *
 * Mirrors the built-in `/connect` interaction for the providers this plugin
 * registers: pick a provider, then either add an account (paste an API key),
 * activate one that already exists, rename it, or delete it. Everything goes
 * through the normal server API, so credentials land in opencode's own store.
 *
 * Why this looks a bit different from the built-in dialog: the plugin API
 * (`ctx.ui.dialog.select`) is a one-shot, non-reactive wrapper. Options are
 * frozen when the prompt opens and actions cannot be hidden or disabled, so we
 * cannot mutate a row in place the way the core `DialogIntegration` does. This
 * flow instead re-opens the account manager after every mutation to show fresh
 * state, and uses `dialog.confirm` for the delete confirmation.
 */

import type { IntegrationInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"

import { registryRpc } from "../rpc.ts"

type Context = Plugin.Context
type Connection = IntegrationInfo["connections"][number]
type CredentialConnection = Extract<Connection, { type: "credential" }>

const INTEGRATION_SOURCE = "opencode-providers"
const ADD_ACCOUNT = "\u0000add-account"

export async function connectProviders(ctx: Context): Promise<void> {
  while (true) {
    const integrations = ownIntegrations(ctx).toSorted((a, b) => a.name.localeCompare(b.name))

    if (integrations.length === 0) {
      // Nothing to connect yet — offer the refresh here rather than making the user
      // restart the service and wait out the 6h TTL.
      const confirmed = await ctx.ui.dialog.confirm({
        title: "Connect providers",
        message:
          "No providers from the registry are available. Force a refresh to re-fetch the registry, then run /connect-providers again.",
        label: { confirm: "Force refresh" },
      })
      if (confirmed) {
        const ok = await refreshWithProgress(ctx)
        // No dialog follows this branch, so close the refresh modal ourselves.
        ctx.ui.dialog.clear()
        if (ok) {
          ctx.ui.toast.show({
            variant: "info",
            message: "Reloaded. Run /connect-providers again to connect a provider.",
          })
        }
      }
      return
    }

    let refreshRequested = false
    const selected = await ctx.ui.dialog.select<string>({
      title: "Connect providers",
      options: integrations.map((integration) => ({
        title: integration.name,
        value: integration.id,
        footer: footer(integration),
      })),
      actions: [
        {
          title: "Force refresh",
          bind: "ctrl+r",
          selection: "none",
          onTrigger: () => {
            refreshRequested = true
            ctx.ui.dialog.clear()
          },
        },
      ],
    })

    // The dialog is static, so a triggered action only records intent and closes
    // the prompt; the work (and the re-open with fresh data) happens out here.
    if (refreshRequested) {
      await refreshWithProgress(ctx)
      continue
    }
    if (selected === undefined) return

    const integration = integrations.find((item) => item.id === selected)
    if (integration === undefined) return

    await openProvider(ctx, integration)
    return
  }
}

/**
 * Show the "Refreshing registry…" modal and force a refresh.
 *
 * The modal is intentionally **not** cleared here: clearing it the moment the
 * refresh resolves raced the renderer and turned it into a sub-frame flash the
 * user never sees. The caller closes it explicitly (the empty state, which opens
 * no follow-up dialog) or lets the reopened dialog replace it (the list state),
 * so it stays up for the whole refresh.
 */
async function refreshWithProgress(ctx: Context): Promise<boolean> {
  void ctx.ui.dialog.alert({ title: "Connect providers", message: "Refreshing registry…" })
  return forceRefresh(ctx)
}

/**
 * Re-fetch the registry through the server RPC (bypasses the TTL) and refresh the
 * provider list. Returns whether it succeeded. A failure only surfaces as an
 * error toast: the previously registered providers stay usable, so nothing is
 * invalidated.
 *
 * Single-flight: concurrent callers share one refresh. The blocking modal makes
 * a second trigger hard to reach, but the command palette is `mode: "global"`
 * and can still re-enter this flow, so the guard keeps network work idempotent.
 */
let refreshInFlight: Promise<boolean> | undefined

export function forceRefresh(ctx: Context): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight
  const pending = doRefresh(ctx).finally(() => {
    if (refreshInFlight === pending) refreshInFlight = undefined
  })
  refreshInFlight = pending
  return pending
}

async function doRefresh(ctx: Context): Promise<boolean> {
  try {
    // 注册是**按 location** 的：不限定 location 的 RPC 只会刷新服务端的**默认目录**，
    // 用户所在的目录会一直停在旧的模型列表（且刷新出来的事件也落在默认目录）。
    // 所以必须带上当前 location。
    const directory = ctx.location?.directory
    const result = await ctx.client
      .rpc(registryRpc)
      .refresh({}, directory === undefined ? undefined : { location: { directory } })
    if (!result.ok) {
      const detail = (result.errors ?? ["unknown error"]).join("; ")
      ctx.ui.toast.show({ variant: "error", message: `Registry refresh failed: ${detail}` })
      return false
    }
    // `invalidate` alone only drops the sync marker — it does not refetch, so
    // `list()` would keep returning the stale integrations. `reloadCatalog`
    // also awaits the sync, so the reopened list shows the freshly registered set.
    await reloadCatalog(ctx)
    ctx.ui.toast.show({
      variant: "success",
      message: `Registry refreshed: ${result.providers ?? 0} providers, ${result.models ?? 0} models`,
    })
    return true
  } catch (error) {
    ctx.ui.toast.show({ variant: "error", message: message(error) })
    return false
  }
}

/**
 * Account manager. Loops so mutations (add / activate / rename / delete) land on
 * a freshly re-read account list while the prompt stays open, matching the
 * built-in behaviour. Returns when the user backs out.
 */
async function openProvider(ctx: Context, integration: IntegrationInfo): Promise<void> {
  while (true) {
    const current = integrationByID(ctx, integration.id) ?? integration
    const credentials = credentialConnections(current)
    const active = credentials[0]

    if (credentials.length === 0) {
      await connectKey(ctx, current)
      return
    }

    let rename: string | undefined
    let remove: string | undefined
    const choice = await ctx.ui.dialog.select<string>({
      title: current.name,
      current: active?.id,
      options: [
        {
          title: "Add account",
          value: ADD_ACCOUNT,
          description: "Paste another API key; it becomes the active account",
        },
        ...credentials.toSorted((a, b) => a.label.localeCompare(b.label)).map((credential) => ({
          title: credential.label,
          value: credential.id,
          category: "Accounts",
          footer: credential.id === active?.id ? "active" : undefined,
        })),
      ],
      actions: [
        {
          title: "rename",
          bind: "ctrl+r",
          selection: "required",
          onTrigger: (value) => {
            // Actions cannot be hidden while "Add account" is focused, so guard here.
            if (value === ADD_ACCOUNT) return
            rename = value
            ctx.ui.dialog.clear()
          },
        },
        {
          title: "delete",
          bind: "ctrl+d",
          selection: "required",
          onTrigger: (value) => {
            if (value === ADD_ACCOUNT) return
            remove = value
            ctx.ui.dialog.clear()
          },
        },
      ],
    })

    if (rename !== undefined) {
      await renameAccount(ctx, current, rename)
      continue
    }
    if (remove !== undefined) {
      if (await deleteAccount(ctx, current, remove)) return
      continue
    }

    if (choice === undefined) return

    if (choice === ADD_ACCOUNT) {
      await connectKey(ctx, current)
      continue
    }

    if (choice === active?.id) continue
    const credential = credentials.find((item) => item.id === choice)
    try {
      await ctx.client.credential.activate({ credentialID: choice })
      await reloadIntegrations(ctx)
      ctx.ui.toast.show({ variant: "success", message: `Activated ${credential?.label ?? choice}` })
    } catch (error) {
      ctx.ui.toast.show({ variant: "error", message: message(error) })
    }
  }
}

async function renameAccount(ctx: Context, integration: IntegrationInfo, credentialID: string): Promise<void> {
  const credential = credentialConnections(integration).find((item) => item.id === credentialID)
  if (credential === undefined) return

  const value = await ctx.ui.dialog.prompt({
    title: "Rename account",
    placeholder: "Account name",
    value: credential.label,
  })
  if (value === undefined) return

  const label = value.trim()
  if (label === "" || label === credential.label) return

  try {
    await ctx.client.credential.update({ credentialID, label })
    await reloadIntegrations(ctx)
    ctx.ui.toast.show({ variant: "success", message: `Renamed to ${label}` })
  } catch (error) {
    ctx.ui.toast.show({ variant: "error", message: message(error) })
  }
}

/** Returns whether the manager should close (the last account was removed). */
async function deleteAccount(ctx: Context, integration: IntegrationInfo, credentialID: string): Promise<boolean> {
  const credentials = credentialConnections(integration)
  const credential = credentials.find((item) => item.id === credentialID)
  if (credential === undefined) return false

  const confirmed = await ctx.ui.dialog.confirm({
    title: "Delete account",
    message: `Delete "${credential.label}" from ${integration.name}?`,
    label: { confirm: "Delete", cancel: "Cancel" },
  })
  if (confirmed !== true) return false

  const last = credentials.length === 1
  try {
    await ctx.client.credential.remove({ credentialID })
    await reloadIntegrations(ctx)
    if (last) {
      ctx.ui.toast.show({ variant: "success", message: `Disconnected ${integration.name}` })
      return true
    }
    return false
  } catch (error) {
    ctx.ui.toast.show({ variant: "error", message: message(error) })
    return false
  }
}

async function connectKey(ctx: Context, integration: IntegrationInfo): Promise<void> {
  const description =
    typeof integration.metadata?.keyLabel === "string" ? integration.metadata.keyLabel : "Enter your API key"

  const key = await ctx.ui.dialog.prompt({
    title: integration.name,
    description,
    placeholder: "sk-...",
  })
  if (key === undefined || key.trim() === "") return

  try {
    await ctx.client.integration.connect.key({ integrationID: integration.id, key: key.trim() })
    await reloadIntegrations(ctx)
    ctx.ui.toast.show({ variant: "success", message: `${integration.name} connected` })
  } catch (error) {
    ctx.ui.toast.show({ variant: "error", message: message(error) })
  }
}

/** Drop the cached integration list and re-read it so the loop sees fresh accounts. */
async function reloadIntegrations(ctx: Context): Promise<void> {
  ctx.data.location.integration.invalidate(ctx.location)
  try {
    await ctx.data.location.integration.sync(ctx.location)
  } catch {
    // A failed sync still leaves `list()` readable; the next action retries.
  }
}

/**
 * Drop every location collection a registry refresh can change, then re-read them.
 *
 * A refresh often adds models to an **existing** provider (the integration set stays the
 * same). The server's `provider.updated` → `model.updated` chain only starts from an
 * `Integration.Event.Updated` / credential change, so that path never reaches the TUI
 * model list — the model selector would stay stale until restart. Invalidate the whole
 * catalog here instead of relying on the event chain.
 */
async function reloadCatalog(ctx: Context): Promise<void> {
  const { integration, model, provider } = ctx.data.location
  for (const collection of [integration, model, provider]) collection.invalidate(ctx.location)
  await Promise.all(
    [integration, model, provider].map((collection) =>
      collection.sync(ctx.location).catch(() => {
        // A failed sync still leaves `list()` readable; the next action retries.
      }),
    ),
  )
}

function ownIntegrations(ctx: Context): IntegrationInfo[] {
  return (ctx.data.location.integration.list(ctx.location) ?? []).filter(
    (integration) => integration.metadata?.source === INTEGRATION_SOURCE,
  )
}

function integrationByID(ctx: Context, id: string): IntegrationInfo | undefined {
  return ownIntegrations(ctx).find((integration) => integration.id === id)
}

function credentialConnections(integration: IntegrationInfo): CredentialConnection[] {
  return integration.connections.filter(
    (connection): connection is CredentialConnection => connection.type === "credential",
  )
}

function footer(integration: IntegrationInfo): string | undefined {
  // Key-only by design (the registry only ever declares a `key` method), so there is
  // no OAuth "pending" connection to advertise here — only existing account labels.
  const credentials = credentialConnections(integration)
  if (credentials.length === 0) return undefined
  return credentials.map((credential) => credential.label).join(", ")
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
