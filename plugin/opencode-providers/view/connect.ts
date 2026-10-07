/**
 * `/connect-providers` flow.
 *
 * Mirrors the built-in `/connect` interaction for the providers this plugin
 * registers: pick a provider, then either add an account (paste an API key) or
 * activate one that already exists. Everything goes through the normal server
 * API, so credentials land in opencode's own store.
 *
 * Out of scope on purpose (use the built-in `/connect` for these): renaming and
 * deleting accounts. Renaming needs a bound footer action; deletion needs a
 * confirm binding. Both are cosmetic actions on the same records.
 */

import type { IntegrationInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"

type Context = Plugin.Context
type Connection = IntegrationInfo["connections"][number]

const INTEGRATION_SOURCE = "opencode-providers"
const ADD_ACCOUNT = "\u0000add-account"

export async function connectProviders(ctx: Context): Promise<void> {
  const integrations = ownIntegrations(ctx).toSorted((a, b) => a.name.localeCompare(b.name))

  if (integrations.length === 0) {
    await ctx.ui.dialog.alert({
      title: "Connect providers",
      message:
        "No providers from the registry are available. Check that the registry loaded (server log) and restart the service.",
    })
    return
  }

  const selected = await ctx.ui.dialog.select<string>({
    title: "Connect providers",
    options: integrations.map((integration) => ({
      title: integration.name,
      value: integration.id,
      footer: footer(integration),
    })),
  })
  if (selected === undefined) return

  const integration = integrations.find((item) => item.id === selected)
  if (integration === undefined) return

  await openProvider(ctx, integration)
}

async function openProvider(ctx: Context, integration: IntegrationInfo): Promise<void> {
  const credentials = credentialConnections(integration)
  const active = credentials[0]

  if (credentials.length === 0) {
    await connectKey(ctx, integration)
    return
  }

  const choice = await ctx.ui.dialog.select<string>({
    title: integration.name,
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
  })
  if (choice === undefined) return

  if (choice === ADD_ACCOUNT) {
    await connectKey(ctx, integration)
    return
  }

  const credential = credentials.find((item) => item.id === choice)
  try {
    await ctx.client.credential.activate({ credentialID: choice })
    ctx.ui.toast.show({ variant: "success", message: `Activated ${credential?.label ?? choice}` })
  } catch (error) {
    ctx.ui.toast.show({ variant: "error", message: message(error) })
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
    ctx.data.location.integration.invalidate(ctx.location)
    ctx.ui.toast.show({ variant: "success", message: `${integration.name} connected` })
  } catch (error) {
    ctx.ui.toast.show({ variant: "error", message: message(error) })
  }
}

function ownIntegrations(ctx: Context): IntegrationInfo[] {
  return (ctx.data.location.integration.list(ctx.location) ?? []).filter(
    (integration) => integration.metadata?.source === INTEGRATION_SOURCE,
  )
}

function credentialConnections(integration: IntegrationInfo): Array<Extract<Connection, { type: "credential" }>> {
  return integration.connections.filter(
    (connection): connection is Extract<Connection, { type: "credential" }> => connection.type === "credential",
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
