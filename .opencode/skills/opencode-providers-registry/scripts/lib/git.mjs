/**
 * git 薄封装：`commit` / `push` 子命令共用。
 *
 * 两个职责：
 *   1) 找到注册表根所在的 git 仓库（`--root` 指向副本且不在仓库里时明确报错）；
 *   2) 把「已暂存的注册表改动」翻译成一行中文提交信息（`-m` 可覆盖）。
 * 只在 `commit` / `push` 里用；写命令（add- / set- / remove- 系列）不碰 git。
 */

import { spawnSync } from "node:child_process"

import { CliError } from "./cli.mjs"

/** 跑一条 git 命令；非零退出抛 CliError（`allowFailure` 时返回结果交给调用方）。 */
export function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (result.error) throw new CliError(`无法执行 git：${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    throw new CliError(`git ${args.join(" ")} 失败：\n${(result.stderr || result.stdout).trim()}`)
  }
  return result
}

/** 注册表根所在的 git 工作树顶层；不在任何仓库里返回 undefined。 */
export function findGitRoot(dir) {
  const result = git(dir, ["rev-parse", "--show-toplevel"], { allowFailure: true })
  if (result.status !== 0) return undefined
  const top = result.stdout.trim()
  return top === "" ? undefined : top
}

const toPosix = (path) => path.replace(/\\/g, "/")

/** `git show <spec>`（`<spec>` 形如 `HEAD:registry/…` 或 `:registry/…`）的内容；不存在返回 undefined。 */
function showBlob(gitRoot, spec) {
  const result = git(gitRoot, ["show", spec], { allowFailure: true })
  return result.status === 0 ? result.stdout : undefined
}

const keysOf = (json) => (json ? Object.keys(json) : [])

const quoteList = (keys) => keys.map((key) => `"${key}"`).join(", ")

/**
 * 把 `git diff --cached --name-status` 的登记（相对 gitRoot）翻成中文短语列表。
 * 只认注册表的三类文件：provider.json / models.json / models/<lab>/<model>.json。
 */
export function describeStagedChanges(gitRoot, relRoot, nameStatus) {
  const rel = (path) => {
    const norm = toPosix(path)
    if (relRoot === "." || relRoot === "") return norm
    return norm.startsWith(`${relRoot}/`) ? norm.slice(relRoot.length + 1) : norm
  }

  const providers = new Map()
  const shared = []
  for (const line of nameStatus.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    const parts = trimmed.split("\t")
    const status = parts[0][0] // 取状态码首字母（重命名 "R100" → "R"，取目标路径）
    const path = parts[parts.length - 1]
    const entry = rel(path)

    let match = /^providers\/([^/]+)\/provider\.json$/.exec(entry)
    if (match) {
      providers.set(match[1], { ...(providers.get(match[1]) ?? {}), provider: status })
      continue
    }
    match = /^providers\/([^/]+)\/models\.json$/.exec(entry)
    if (match) {
      const gitPath = toPosix(path)
      const head = status === "A" ? {} : JSON.parse(showBlob(gitRoot, `HEAD:${gitPath}`) ?? "{}")
      const staged = status === "D" ? {} : JSON.parse(showBlob(gitRoot, `:${gitPath}`) ?? "{}")
      providers.set(match[1], {
        ...(providers.get(match[1]) ?? {}),
        models: {
          added: Object.keys(staged).filter((key) => !(key in head)),
          removed: Object.keys(head).filter((key) => !(key in staged)),
          changed: Object.keys(staged).filter((key) => key in head && JSON.stringify(staged[key]) !== JSON.stringify(head[key])),
          stagedKeys: keysOf(staged),
          headKeys: keysOf(head),
        },
      })
      continue
    }
    match = /^models\/(.+)\.json$/.exec(entry)
    if (match) shared.push({ ref: match[1], status })
  }

  const phrases = []
  for (const [id, info] of [...providers.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (info.provider === "A") {
      const models = info.models?.stagedKeys ?? []
      phrases.push(`新增供应商 "${id}"${models.length ? `（模型：${models.join(", ")}）` : ""}`)
      continue
    }
    if (info.provider === "D") {
      const models = info.models?.headKeys ?? []
      phrases.push(`删除供应商 "${id}"${models.length ? `（模型：${models.join(", ")}）` : ""}`)
      continue
    }
    if (info.provider === "M") phrases.push(`更新供应商 "${id}"`)
    if (info.models) {
      if (info.models.added.length) phrases.push(`给供应商 "${id}" 添加模型 ${quoteList(info.models.added)}`)
      if (info.models.removed.length) phrases.push(`删除供应商 "${id}" 的模型 ${quoteList(info.models.removed)}`)
      if (info.models.changed.length) phrases.push(`更新供应商 "${id}" 的模型 ${quoteList(info.models.changed)}`)
    }
  }
  for (const { ref, status } of shared.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))) {
    if (status === "A") phrases.push(`新增共享模型 "${ref}"`)
    else if (status === "D") phrases.push(`删除共享模型 "${ref}"`)
    else phrases.push(`更新共享模型 "${ref}"`)
  }

  return phrases.length > 0 ? phrases.join("；") : "更新注册表"
}

/** 推送当前分支到 origin，返回分支名。 */
export function pushBranch(gitRoot) {
  const branch = git(gitRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()
  git(gitRoot, ["push", "origin", branch])
  return branch
}
