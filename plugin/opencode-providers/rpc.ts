/**
 * RPC definition for the server entry's force refresh.
 *
 * Plain JSON Schema — no `effect`, no `@opencode/*` — so `index.ts` stays free
 * of `@opencode/*` imports (a locally installed server plugin does not get the
 * module injected). `Rpc.define` is the identity function and the core parser
 * accepts plain JSON Schema, so `ctx.rpc.register(registryRpc, …)` can take this
 * object as-is.
 */

export const registryRpc = {
  id: "opencode-providers",
  methods: {
    refresh: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          providers: { type: "number" },
          models: { type: "number" },
          source: { type: "string" },
          fetchedAt: { type: "number" },
          errors: { type: "array", items: { type: "string" } },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const

export interface RefreshSummary {
  readonly ok: boolean
  readonly providers?: number
  readonly models?: number
  readonly source?: string
  readonly fetchedAt?: number
  readonly errors?: readonly string[]
}