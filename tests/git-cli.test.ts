import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(
  new URL("../.opencode/skills/opencode-providers-registry/scripts/registry.mjs", import.meta.url),
)
const SHIPPED_ROOT = fileURLToPath(new URL("../registry", import.meta.url))

/** 提交/推送类命令不是「注册表数据」操作，用随仓无关的全新供应商驱动，钉住 git 行为。 */
const NEW_ID = "zz-git-new"
const NEW_URL = "https://api.zz-git-new.test/v1"

function git(dir: string, args: readonly string[]) {
  const result = spawnSync("git", [...args], { cwd: dir, encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} 失败：\n${result.stderr}`)
  return result.stdout.trim()
}

function cli(args: readonly string[], root: string) {
  return spawnSync(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8" })
}

/** 用 add-provider（随仓无关的新供应商）制造一次真实的注册表改动。 */
function addProvider(root: string) {
  const result = cli(
    [
      "add-provider", "--id", NEW_ID, "--name", "ZZ Git New", "--baseurl", NEW_URL,
      "--model", "m1", "--inline", "--context", "100", "--output", "10",
    ],
    root,
  )
  assert.equal(result.status, 0, result.stderr)
}

/** 临时副本 + `git init` + 一次初始提交；副本在系统临时目录，不碰仓库。 */
function freshGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-registry-git-"))
  cpSync(SHIPPED_ROOT, join(dir, "registry"), { recursive: true })
  git(dir, ["init", "-q", "-b", "main"])
  git(dir, ["config", "core.autocrlf", "false"])
  git(dir, ["config", "user.email", "test@example.com"])
  git(dir, ["config", "user.name", "Test"])
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-q", "-m", "初始"])
  return dir
}

/** 建一个裸仓库当 origin，并让工作副本的 main 已跟踪它。 */
function withBareRemote(dir: string) {
  const remote = mkdtempSync(join(tmpdir(), "opencode-registry-remote-"))
  git(remote, ["init", "-q", "--bare", "-b", "main"])
  git(dir, ["remote", "add", "origin", remote])
  git(dir, ["push", "-q", "-u", "origin", "main"])
  return remote
}

test("commit：自动生成中文提交信息，只提交注册表改动", () => {
  const dir = freshGitRepo()
  const root = join(dir, "registry")
  addProvider(root)

  const result = cli(["commit"], root)
  assert.equal(result.status, 0, result.stderr)

  const subject = git(dir, ["log", "-1", "--format=%s"])
  assert.match(subject, /新增供应商 "zz-git-new"/)
  assert.match(subject, /m1/)
  // 提交后注册表工作区干净
  assert.equal(git(dir, ["status", "--porcelain", "--", "registry"]), "")
})

test("commit：没有改动时拒绝提交且不产生新提交", () => {
  const dir = freshGitRepo()
  const root = join(dir, "registry")
  const before = git(dir, ["rev-list", "--count", "HEAD"])

  const result = cli(["commit"], root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /没有要提交/)
  assert.equal(git(dir, ["rev-list", "--count", "HEAD"]), before)
})

test("commit：不误伤其他已暂存文件（作用域安全）", () => {
  const dir = freshGitRepo()
  const root = join(dir, "registry")
  writeFileSync(join(dir, "other.txt"), "keep me\n")
  git(dir, ["add", "other.txt"])
  addProvider(root)

  const result = cli(["commit"], root)
  assert.equal(result.status, 0, result.stderr)

  const tree = git(dir, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n")
  assert.ok(!tree.includes("other.txt"), "无关文件不应进入这次提交")
  assert.ok(git(dir, ["diff", "--cached", "--name-only"]).split("\n").includes("other.txt"))
})

test("commit --message：覆盖自动提交信息", () => {
  const dir = freshGitRepo()
  const root = join(dir, "registry")
  addProvider(root)

  const result = cli(["commit", "--message", "自定义提交信息"], root)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(git(dir, ["log", "-1", "--format=%s"]), "自定义提交信息")
})

test("commit：不在 git 仓库里时报错", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-registry-nogit-"))
  cpSync(SHIPPED_ROOT, join(dir, "registry"), { recursive: true })

  const result = cli(["commit"], join(dir, "registry"))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /git 仓库/)
})

test("commit：注册表校验不通过则拒绝提交", () => {
  const dir = freshGitRepo()
  const root = join(dir, "registry")
  addProvider(root)

  const indexPath = join(root, "index.json")
  const manifest = JSON.parse(readFileSync(indexPath, "utf8"))
  manifest.revision = `sha256:${"0".repeat(64)}`
  writeFileSync(indexPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const before = git(dir, ["rev-list", "--count", "HEAD"])
  const result = cli(["commit"], root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /revision|校验/)
  assert.equal(git(dir, ["rev-list", "--count", "HEAD"]), before)
})

test("commit --push：提交并推送到 origin 当前分支", () => {
  const dir = freshGitRepo()
  const root = join(dir, "registry")
  const remote = withBareRemote(dir)
  addProvider(root)

  const result = cli(["commit", "--push"], root)
  assert.equal(result.status, 0, result.stderr)

  assert.equal(git(remote, ["rev-parse", "main"]), git(dir, ["rev-parse", "HEAD"]))
})

test("push：推送当前分支到 origin", () => {
  const dir = freshGitRepo()
  const root = join(dir, "registry")
  const remote = withBareRemote(dir)
  addProvider(root)

  assert.equal(cli(["commit"], root).status, 0)
  const result = cli(["push"], root)
  assert.equal(result.status, 0, result.stderr)

  assert.equal(git(remote, ["rev-parse", "main"]), git(dir, ["rev-parse", "HEAD"]))
})
