/**
 * Registry schema + validation.
 *
 * Dependency-free and runtime-agnostic on purpose: the server entry, the TUI
 * entry and `node --test` all import this module, so it must not touch
 * `@opencode/*`, JSX or Node built-ins.
 */

export const SUPPORTED_SCHEMA_VERSION = 1

export type ModelStatus = "alpha" | "beta" | "deprecated" | "active"

export interface Limit {
  readonly context: number
  readonly input?: number
  readonly output: number
}

export interface Cost {
  readonly input: number
  readonly output: number
  readonly cache_read?: number
  readonly cache_write?: number
}

export interface Variant {
  readonly id: string
  readonly settings?: Readonly<Record<string, unknown>>
}

/** Provider-agnostic model facts. Shared by every provider through `base`. */
export interface RegistryModel {
  readonly name?: string
  readonly family?: string
  readonly releaseDate?: string
  readonly status?: ModelStatus
  readonly disabled?: boolean
  readonly limit: Limit
  readonly cost?: Cost
  readonly tools?: boolean
  readonly input?: readonly string[]
  readonly output?: readonly string[]
  /** `Model.Compatibility.reasoningField` */
  readonly reasoningField?: string
  /** `Model.Compatibility.maxTokensField` */
  readonly maxTokensField?: "max_tokens" | "max_completion_tokens"
  readonly variants?: readonly Variant[]
}

/**
 * A model as exposed by one provider. `id` is the map key; everything else is
 * optional and layered over the shared model named by `base`.
 */
export interface ModelSpec {
  readonly base?: string
  /** Model or deployment ID sent upstream. Defaults to the map key. */
  readonly modelID?: string
  readonly name?: string
  readonly family?: string
  readonly releaseDate?: string
  readonly status?: ModelStatus
  readonly disabled?: boolean
  readonly limit?: Limit
  readonly cost?: Cost
  readonly tools?: boolean
  readonly input?: readonly string[]
  readonly output?: readonly string[]
  readonly reasoningField?: string
  readonly maxTokensField?: "max_tokens" | "max_completion_tokens"
  readonly variants?: readonly Variant[]
}

export interface ProviderEntry {
  readonly name: string
  /** Runtime provider package, e.g. `@opencode/ai/providers/openai-compatible`. */
  readonly package: string
  readonly baseURL?: string
  /** Extra provider settings merged over `{ baseURL }`. */
  readonly settings?: Readonly<Record<string, unknown>>
  readonly headers?: Readonly<Record<string, string>>
  /** Label for the `/connect...` key prompt. Defaults to "Paste API key". */
  readonly keyLabel?: string
  readonly models: Readonly<Record<string, ModelSpec>>
}

export interface Registry {
  readonly schemaVersion: number
  readonly models: Readonly<Record<string, RegistryModel>>
  readonly providers: Readonly<Record<string, ProviderEntry>>
}

export type ParseResult = { readonly ok: true; readonly registry: Registry } | { readonly ok: false; readonly errors: readonly string[] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0

const isNonNegativeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

const STATUSES: readonly ModelStatus[] = ["alpha", "beta", "deprecated", "active"]

function checkLimit(value: unknown, path: string, errors: string[]): value is Limit {
  if (!isRecord(value)) {
    errors.push(`${path}: must be an object`)
    return false
  }
  let valid = true
  if (!isPositiveInt(value.context)) {
    errors.push(`${path}.context: must be a positive integer`)
    valid = false
  }
  if (!isPositiveInt(value.output)) {
    errors.push(`${path}.output: must be a positive integer`)
    valid = false
  }
  if (value.input !== undefined && !isPositiveInt(value.input)) {
    errors.push(`${path}.input: must be a positive integer when present`)
    valid = false
  }
  return valid
}

function checkCost(value: unknown, path: string, errors: string[]): boolean {
  if (!isRecord(value)) {
    errors.push(`${path}: must be an object`)
    return false
  }
  let valid = true
  for (const field of ["input", "output"] as const) {
    if (!isNonNegativeNumber(value[field])) {
      errors.push(`${path}.${field}: must be a number >= 0`)
      valid = false
    }
  }
  for (const field of ["cache_read", "cache_write"] as const) {
    if (value[field] !== undefined && !isNonNegativeNumber(value[field])) {
      errors.push(`${path}.${field}: must be a number >= 0 when present`)
      valid = false
    }
  }
  return valid
}

function checkVariants(value: unknown, path: string, errors: string[]): boolean {
  if (!Array.isArray(value)) {
    errors.push(`${path}: must be an array`)
    return false
  }
  let valid = true
  value.forEach((variant, index) => {
    if (!isRecord(variant) || typeof variant.id !== "string" || !variant.id) {
      errors.push(`${path}[${index}].id: must be a non-empty string`)
      valid = false
    }
  })
  return valid
}

/** Validates the fields a model may declare; `requireLimit` is false for provider overrides. */
function checkModelFields(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
  options: { readonly requireLimit: boolean },
) {
  if (value.limit !== undefined) checkLimit(value.limit, `${path}.limit`, errors)
  else if (options.requireLimit) errors.push(`${path}.limit: required`)

  if (value.cost !== undefined) checkCost(value.cost, `${path}.cost`, errors)
  if (value.variants !== undefined) checkVariants(value.variants, `${path}.variants`, errors)

  if (value.tools !== undefined && typeof value.tools !== "boolean") errors.push(`${path}.tools: must be a boolean`)
  if (value.disabled !== undefined && typeof value.disabled !== "boolean")
    errors.push(`${path}.disabled: must be a boolean`)
  if (value.input !== undefined && !isStringArray(value.input)) errors.push(`${path}.input: must be an array of strings`)
  if (value.output !== undefined && !isStringArray(value.output))
    errors.push(`${path}.output: must be an array of strings`)

  for (const field of ["name", "family", "releaseDate", "reasoningField"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") errors.push(`${path}.${field}: must be a string`)
  }
  if (value.modelID !== undefined && (typeof value.modelID !== "string" || !value.modelID))
    errors.push(`${path}.modelID: must be a non-empty string`)
  if (value.status !== undefined && !STATUSES.includes(value.status as ModelStatus))
    errors.push(`${path}.status: must be one of ${STATUSES.join(", ")}`)
  if (value.maxTokensField !== undefined && value.maxTokensField !== "max_tokens" && value.maxTokensField !== "max_completion_tokens")
    errors.push(`${path}.maxTokensField: must be "max_tokens" or "max_completion_tokens"`)
}

export function parseRegistry(input: unknown): ParseResult {
  const errors: string[] = []

  if (!isRecord(input)) return { ok: false, errors: ["registry: must be an object"] }

  if (input.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion: unsupported value ${JSON.stringify(input.schemaVersion)} (this plugin supports ${SUPPORTED_SCHEMA_VERSION})`,
    )
  }

  const shared: Record<string, RegistryModel> = {}
  const rawModels = input.models ?? {}
  if (!isRecord(rawModels)) {
    errors.push("models: must be an object")
  } else {
    for (const [key, value] of Object.entries(rawModels)) {
      const path = `models.${key}`
      if (!isRecord(value)) {
        errors.push(`${path}: must be an object`)
        continue
      }
      checkModelFields(value, path, errors, { requireLimit: true })
      shared[key] = value as unknown as RegistryModel
    }
  }

  const providers: Record<string, ProviderEntry> = {}
  const rawProviders = input.providers
  if (!isRecord(rawProviders) || Object.keys(rawProviders).length === 0) {
    errors.push("providers: must be a non-empty object")
  } else {
    for (const [id, value] of Object.entries(rawProviders)) {
      const path = `providers.${id}`
      if (!isRecord(value)) {
        errors.push(`${path}: must be an object`)
        continue
      }
      if (typeof value.name !== "string" || !value.name) errors.push(`${path}.name: must be a non-empty string`)
      if (typeof value.package !== "string" || !value.package) errors.push(`${path}.package: must be a non-empty string`)
      if (value.baseURL !== undefined && typeof value.baseURL !== "string") errors.push(`${path}.baseURL: must be a string`)
      if (value.keyLabel !== undefined && typeof value.keyLabel !== "string") errors.push(`${path}.keyLabel: must be a string`)
      if (value.settings !== undefined && !isRecord(value.settings)) errors.push(`${path}.settings: must be an object`)
      if (value.headers !== undefined) {
        if (!isRecord(value.headers) || !Object.values(value.headers).every((header) => typeof header === "string"))
          errors.push(`${path}.headers: must be an object of strings`)
      }

      const models: Record<string, ModelSpec> = {}
      if (!isRecord(value.models) || Object.keys(value.models).length === 0) {
        errors.push(`${path}.models: must be a non-empty object`)
      } else {
        for (const [modelID, spec] of Object.entries(value.models)) {
          const modelPath = `${path}.models.${modelID}`
          if (!isRecord(spec)) {
            errors.push(`${modelPath}: must be an object`)
            continue
          }
          checkModelFields(spec, modelPath, errors, { requireLimit: spec.base === undefined })
          if (spec.base !== undefined) {
            if (typeof spec.base !== "string") errors.push(`${modelPath}.base: must be a string`)
            else if (!(spec.base in shared)) errors.push(`${modelPath}.base: unknown shared model "${spec.base}"`)
          }
          models[modelID] = spec as unknown as ModelSpec
        }
      }

      providers[id] = { ...(value as unknown as ProviderEntry), models }
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, registry: { schemaVersion: SUPPORTED_SCHEMA_VERSION, models: shared, providers } }
}

/** Layers a provider model spec over its shared model, shared first. */
export function resolveModelSpec(registry: Registry, spec: ModelSpec): RegistryModel | undefined {
  const base = spec.base === undefined ? undefined : registry.models[spec.base]
  if (spec.base !== undefined && base === undefined) return undefined
  const { base: _base, modelID: _modelID, ...overrides } = spec
  const model = { ...base, ...overrides } as RegistryModel
  return model.limit === undefined ? undefined : model
}
