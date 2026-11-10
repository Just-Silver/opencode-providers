/**
 * RPC definition for the server entry: registry force refresh plus the global
 * subagent model policy.
 *
 * Plain JSON Schema — no `effect`, no `@opencode/*` — so `index.ts` stays free
 * of `@opencode/*` imports (a locally installed server plugin does not get the
 * module injected). `Rpc.define` is the identity function and the core parser
 * accepts plain JSON Schema, so `ctx.rpc.register(registryRpc, …)` can take this
 * object as-is.
 */

const emptyInput = { type: "object", properties: {}, additionalProperties: false } as const

const subagentModelOutput = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    supported: { type: "boolean" },
    model: { type: ["string", "null"] },
    errors: { type: "array", items: { type: "string" } },
  },
  required: ["ok", "supported"],
  additionalProperties: false,
} as const

export const registryRpc = {
  id: "opencode-providers",
  methods: {
    refresh: {
      input: emptyInput,
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
    getSubagentModel: {
      input: emptyInput,
      output: subagentModelOutput,
    },
    setSubagentModel: {
      input: {
        type: "object",
        properties: { model: { type: ["string", "null"] } },
        required: ["model"],
        additionalProperties: false,
      },
      output: subagentModelOutput,
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

/** `supported` = the host exposes the hook; `ok` = this operation worked. */
export interface SubagentModelSummary {
  readonly ok: boolean
  readonly supported: boolean
  readonly model?: string | null
  readonly errors?: readonly string[]
}
