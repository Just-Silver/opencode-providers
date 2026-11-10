// JSON Schema 保持为普通值，避免 server 依赖宿主未注入的运行时模块。

const emptyInput = { type: "object", properties: {}, additionalProperties: false } as const

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
