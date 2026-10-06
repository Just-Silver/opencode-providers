import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { sectionBody, topVersion } from "../scripts/changelog.mjs"

const SAMPLE = `# Changelog

## [Unreleased]

## [1.2.0-beta.3] - 2026-01-02

### Added

- 新东西

### Fixed

- 修了个 bug

## [1.1.0] - 2025-12-01

### Added

- 旧的

[Unreleased]: https://example.com/compare/v1.2.0-beta.3...HEAD
[1.2.0-beta.3]: https://example.com/releases/tag/v1.2.0-beta.3
[1.1.0]: https://example.com/releases/tag/v1.1.0
`

test("topVersion 跳过 Unreleased，取第一个版本小节（含预发布）", () => {
  assert.equal(topVersion(SAMPLE), "1.2.0-beta.3")
})

test("topVersion 没有版本小节时返回 undefined", () => {
  assert.equal(topVersion("# Changelog\n\n## [Unreleased]\n"), undefined)
})

test("sectionBody 截取正文：不含标题、不含底部链接引用、不留尾部空行", () => {
  const body = sectionBody(SAMPLE, "1.2.0-beta.3")
  assert.equal(body, "### Added\n\n- 新东西\n\n### Fixed\n\n- 修了个 bug")
})

test("sectionBody 能截取中间/最后一个版本小节", () => {
  assert.equal(sectionBody(SAMPLE, "1.1.0"), "### Added\n\n- 旧的")
})

test("sectionBody 对不存在的版本返回 undefined", () => {
  assert.equal(sectionBody(SAMPLE, "9.9.9"), undefined)
})

test("sectionBody 对小节标题里的正则字符安全（如 + 号版本）", () => {
  const text = "## [1.0.0+build.1] - 2026-01-01\n\n- x\n\n## [0.9.0] - 2025-01-01\n"
  assert.equal(sectionBody(text, "1.0.0+build.1"), "- x")
})

test("本仓的 CHANGELOG 顶部版本与 package.json 版本一致", () => {
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8")
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(topVersion(changelog), version)
})

test("本仓当前版本小节的正文非空（release.yml 会用它当 Release 正文）", () => {
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8")
  assert.ok(sectionBody(changelog, topVersion(changelog)).trim().length > 0)
})
