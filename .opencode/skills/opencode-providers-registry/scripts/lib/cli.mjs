/**
 * CLI 基础：参数解析 + 通用校验。纯函数、无副作用、不碰文件系统。
 */

/** 预期内的用户错误：`main` 打印一行 `✗ …` 并以退出码 1 结束（不吐堆栈）。 */
export class CliError extends Error {}

export const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

/** 单个路径段允许的字符（会拼进 `lab/model` 与文件名，禁 `/`、`\`、`:`、空白等）。 */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 只吃 `--flag`（不带值）的布尔开关；`--strict` 仅 `check` 用。 */
const BOOLEAN_FLAGS = new Set(["json", "force", "help", "strict", "inline"])

export function parseArgs(argv) {
  const positional = []
  const flags = {}
  const add = (key, value) => {
    if (key in flags) flags[key] = [...(Array.isArray(flags[key]) ? flags[key] : [flags[key]]), value]
    else flags[key] = value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const eqForm = arg.indexOf("=")
    if (eqForm !== -1) {
      const rawKey = arg.slice(2, eqForm)
      add(rawKey === "base-url" ? "baseurl" : rawKey, arg.slice(eqForm + 1))
      continue
    }
    const rawKey = arg.slice(2)
    // `--base-url` 是常见写法，作为 `--baseurl` 的别名（拼错/未知参数一律报错，别静默忽略）。
    const key = rawKey === "base-url" ? "baseurl" : rawKey
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith("--")) {
      add(key, next)
      index += 1
    } else {
      add(key, true)
    }
  }
  return { positional, flags }
}

export const lastOf = (flags, key) => {
  const value = flags[key]
  return Array.isArray(value) ? value[value.length - 1] : value
}

export const allOf = (flags, key) => {
  const value = flags[key]
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

export function required(flags, key, label) {
  const value = lastOf(flags, key)
  if (typeof value !== "string" || value.trim() === "") throw new CliError(`缺少 ${label}（--${key}）`)
  return value
}

const COMMON_FLAGS = new Set(["json", "help", "root"])

/** 未知参数必须报错——静默忽略会让「拼错的 flag」变成「悄悄少写字段」。 */
export function rejectUnknownFlags(command, flags, allowed) {
  const known = new Set([...COMMON_FLAGS, ...allowed])
  for (const key of Object.keys(flags)) {
    if (known.has(key)) continue
    throw new CliError(`未知参数 --${key}（命令 ${command}）。允许：--${[...allowed].join(" --")}（通用：--json --root）`)
  }
}

export function checkId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new CliError(`${label} "${value}" 非法：只允许字母/数字/._- ，不能以符号开头，段内不能含 / \\ : * ? " < > | 或空格`)
  }
  return value
}

/** `base` 引用：必须恰好两段 `lab/model`，每段过 ID_PATTERN。 */
export function checkBaseRef(value) {
  const text = String(value)
  const segments = text.split("/")
  if (segments.length !== 2) throw new CliError(`--base "${text}" 非法：必须恰好是 <lab>/<model> 两段`)
  for (const segment of segments) checkId(segment, "--base")
  return text
}

export function parsePositiveInt(value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) throw new CliError(`${label} 必须是正整数，收到 ${JSON.stringify(value)}`)
  return number
}
