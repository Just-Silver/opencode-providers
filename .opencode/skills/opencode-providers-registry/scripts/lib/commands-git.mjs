/**
 * git 命令：`commit`（按改动自动生成中文提交信息，只提交注册表路径）与 `push`。
 *
 * 设计：写命令（add- / set- / remove- 系列）**不碰 git**；改完（可多条写命令）跑一次 `commit`
 * 合成**一次提交**，`--push` 再推送。提交前必过 `validate` 级校验（不通过不提交）。
 * 只 `git add -A -- <注册表根>`，因此不会像 `git add -A` 那样误收仓库里的无关改动。
 */

import { relative } from "node:path"

import { CliError, lastOf, rejectUnknownFlags } from "./cli.mjs"
import { collectValidationProblems } from "./commands-read.mjs"
import { findGitRoot, git, describeStagedChanges, pushBranch } from "./git.mjs"
import { resolveRoot } from "./store.mjs"

const toPosix = (path) => path.replace(/\\/g, "/")

/** 解析出注册表根所在的 git 工作树顶层 + 注册表相对路径。不在仓库里直接报错。 */
function locate(root) {
  const gitRoot = findGitRoot(root)
  if (!gitRoot) {
    throw new CliError(
      `注册表目录 "${root}" 不在 git 仓库里，无法提交/推送。\n` +
        `  （副本演练（--root 指向非仓库副本）请手动处理 git；只有仓库里的注册表才由本命令负责）`,
    )
  }
  return { gitRoot, relRoot: toPosix(relative(gitRoot, root)) || "." }
}

export function commandCommit(flags) {
  rejectUnknownFlags("commit", flags, new Set(["message", "push"]))
  const root = resolveRoot(flags)
  const { gitRoot, relRoot } = locate(root)

  const { problems } = collectValidationProblems(root)
  if (problems.length > 0) {
    throw new CliError(`提交前校验未通过（先修正，勿提交坏数据）：\n- ${problems.join("\n- ")}`)
  }

  git(gitRoot, ["add", "-A", "--", relRoot])
  const nameStatus = git(gitRoot, ["diff", "--cached", "--name-status", "--", relRoot]).stdout
  if (nameStatus.trim() === "") throw new CliError("没有要提交的注册表改动（工作区与 HEAD 一致）")

  const message = lastOf(flags, "message") ?? describeStagedChanges(gitRoot, relRoot, nameStatus)
  git(gitRoot, ["commit", "-m", message, "--", relRoot])
  console.log(`✓ 已提交注册表改动（${gitRoot}）`)
  console.log(`  ${message}`)

  if (flags.push === true) {
    const branch = pushBranch(gitRoot)
    console.log(`✓ 已推送 ${branch} → origin`)
  }
}

export function commandPush(flags) {
  rejectUnknownFlags("push", flags, new Set())
  const root = resolveRoot(flags)
  const { gitRoot } = locate(root)
  const branch = pushBranch(gitRoot)
  console.log(`✓ 已推送 ${branch} → origin（${gitRoot}）`)
}
