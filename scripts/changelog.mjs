#!/usr/bin/env node
/**
 * 版本一致性 + Release 内容提取（本仓的「单一版本源」= package.json 的 version）。
 *
 *   node scripts/changelog.mjs check [--tag vX.Y.Z]   # tag（可选）/ package.json / CHANGELOG 顶部版本三者一致
 *   node scripts/changelog.mjs notes [--version x.y.z] [--out file]  # 从 CHANGELOG 截取该版本小节作为 Release 正文
 *
 * 约定：CHANGELOG 里 `## [Unreleased]` 是工作区，不计入版本；版本小节格式 `## [x.y.z(-预发布)] - YYYY-MM-DD`。
 * 正文里不含小节标题本身，也不含文件底部的链接引用（`[x.y.z]: https://...`）。
 */

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const HEADING = /^##\s+\[([^\]]+)\]/

/** 版本小节标题（`## [x.y.z]`）——排除 [Unreleased] */
export function topVersion(changelog) {
  for (const line of changelog.split(/\r?\n/)) {
    const match = HEADING.exec(line)
    if (match && match[1].toLowerCase() !== "unreleased") return match[1]
  }
  return undefined
}

/** 截取某个版本小节的正文（不含标题、不含底部链接引用） */
export function sectionBody(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((line) => HEADING.exec(line)?.[1] === version)
  if (start === -1) return undefined
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (HEADING.test(line) || /^\[[^\]]+\]:/.test(line)) break
    body.push(line)
  }
  while (body.length > 0 && body[0].trim() === "") body.shift()
  while (body.length > 0 && body[body.length - 1].trim() === "") body.pop()
  return body.join("\n")
}

function read(relative) {
  return readFileSync(resolve(ROOT, relative), "utf8")
}

function flag(args, name) {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}

function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

function main() {
  const [command, ...args] = process.argv.slice(2)
  const changelog = read("CHANGELOG.md")
  const { version } = JSON.parse(read("package.json"))
  const top = topVersion(changelog)

  if (command === "check") {
    if (top === undefined) fail("CHANGELOG.md 里找不到版本小节（`## [x.y.z]`）")
    const tag = flag(args, "tag")
    const tagged = tag?.replace(/^v/, "")
    console.log(`package.json = ${version}`)
    console.log(`CHANGELOG 顶部 = ${top}`)
    if (tag !== undefined) console.log(`tag = ${tag} (v${tagged})`)
    if (top !== version) fail(`CHANGELOG 顶部版本 ${top} != package.json 版本 ${version}`)
    if (tag !== undefined && tagged !== version) fail(`tag ${tag} != package.json 版本 ${version}`)
    console.log("✓ 版本一致")
    return
  }

  if (command === "notes") {
    const version = flag(args, "version") ?? top
    const body = sectionBody(changelog, version)
    if (body === undefined) fail(`CHANGELOG.md 里找不到版本小节 [${version}]`)
    if (body.trim() === "") fail(`CHANGELOG.md 的 [${version}] 小节是空的`)
    const out = flag(args, "out")
    if (out) {
      writeFileSync(resolve(ROOT, out), `${body}\n`)
      console.log(`✓ 已写出 ${out}（${body.length} 字节）`)
    } else {
      console.log(body)
    }
    return
  }

  fail(`未知子命令：${command ?? "(空)"}（支持 check / notes）`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
