#!/usr/bin/env node
/**
 * 分文件注册表维护 CLI（opencode-providers）。
 *
 * 存在的意义：让 agent **永远不用读整份注册表**（它会随供应商/模型增长），
 * 只用下面的子命令读/写；写入前一律先组装 + `parseRegistry` 校验，冲突直接报错、不落盘。
 * 实现拆在 `lib/`：`cli.mjs`（参数解析/校验）、`store.mjs`（目录树读写/revision）、
 * `spec.mjs`（模型 spec 与补丁）、`report.mjs`（汇总打印）、`commands-{read,write}.mjs`（命令）。
 *
 * 注册表是一棵目录树：
 *   <root>/index.json                  # manifest（本 CLI 自动维护，人手不碰）
 *   <root>/providers/<id>/provider.json
 *   <root>/providers/<id>/models.json
 *   <root>/models/<lab>/<model>.json   # 顶层共享模型（`--base` 复用那一层）
 *
 * 更新一律是**字段补丁**：只改传入的 flag，未传字段保持原样；`--unset a,b` 显式清空（可重复给）。
 * 通用：`--root <注册表目录>` 覆盖默认位置；`--json` 输出机器可读结果。
 */

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { CliError, parseArgs } from "./lib/cli.mjs"
import {
  commandCheck,
  commandList,
  commandSearch,
  commandShow,
  commandValidate,
} from "./lib/commands-read.mjs"
import {
  commandAddModel,
  commandAddProvider,
  commandAddSharedModel,
  commandRemoveModel,
  commandRemoveProvider,
  commandRemoveSharedModel,
  commandSetModel,
  commandSetProvider,
  commandSetSharedModel,
  commandSync,
} from "./lib/commands-write.mjs"
import { commandCommit, commandPush } from "./lib/commands-git.mjs"

const USAGE = `分文件注册表维护 CLI —— agent 不要直接读整份注册表，用这些命令：

  读：
    node scripts/registry.mjs list [--json]                  # 供应商 + 各自模型 + 顶层共享模型
    node scripts/registry.mjs search <关键词> [--json]        # 命中供应商/模型/共享模型（新增前先搜！）
    node scripts/registry.mjs show <供应商id> [模型key]        # 或 show <lab>/<model> 看共享模型
    node scripts/registry.mjs validate                        # 组装 + schema + index/目录/revision 一致性
    node scripts/registry.mjs check [--strict]                # 更全的体检（悬空引用/孤儿/重复 baseURL…）

  写（增）：
    node scripts/registry.mjs add-provider --id ID --name 名称 --baseurl URL \\
        [--protocol chat|responses|messages | --package PKG] \\
        --model KEY (--lab LAB [--lab-key NAME] | --base lab/model | --inline) \\
        [--model-name 名称] [--model-id 上游id] \\
        [--context N --output N] [--variant id[:settingsJSON]] [--force] \\
        [--input text,image,...]
    node scripts/registry.mjs add-model --provider ID --key KEY \\
        (--lab LAB [--lab-key NAME] | --base lab/model | --inline) \\
        [--model-name 名称] [--model-id 上游id] \\
        [--context N --output N] [--variant id[:settingsJSON]] \\
        [--input text,image,...]
    node scripts/registry.mjs add-shared-model --lab LAB --key KEY \\
        [--model-name 名称] [--context N --output N] [--variant id[:settingsJSON]] \\
        [--input text,image,...]

  写（改，字段补丁；--unset 清空）：
    node scripts/registry.mjs set-provider --id ID [--name 名称] [--baseurl URL | --unset baseurl] \\
        [--package PKG | --protocol P]
    node scripts/registry.mjs set-model --provider ID --key KEY [--model-name 名称] [--model-id 上游id] \\
        [--context N --output N] [--variant id[:settingsJSON]] [--input text,image,...] \\
        [--base lab/model] [--unset name,model-id,base,limit,variants,input]
    node scripts/registry.mjs set-shared-model --lab LAB --key KEY [--model-name 名称] \\
        [--context N --output N] [--variant id[:settingsJSON]] [--input text,image,...] \\
        [--unset name,limit,variants,input]

  写（删）：
    node scripts/registry.mjs remove-provider --id ID
    node scripts/registry.mjs remove-model --provider ID --key KEY
    node scripts/registry.mjs remove-shared-model --ref lab/model   # 或 --lab LAB --key KEY

  其它：
    node scripts/registry.mjs sync                           # 手改子文件后重算 revision + 重写 index.json
    node scripts/registry.mjs commit [-m 信息] [--push]      # 提交（自动生成中文信息，只提交注册表路径）
    node scripts/registry.mjs push                           # 推送当前分支到 origin

通用：--root <注册表目录>；--json。`

function run(argv) {
  const { positional, flags } = parseArgs(argv)
  const command = positional.shift()
  switch (command) {
    case "list":
      return commandList(flags)
    case "search":
      return commandSearch(positional, flags)
    case "show":
      return commandShow(positional, flags)
    case "validate":
      return commandValidate(flags)
    case "check":
      return commandCheck(flags)
    case "sync":
      return commandSync(flags)
    case "commit":
      return commandCommit(flags)
    case "push":
      return commandPush(flags)
    case "add-provider":
      return commandAddProvider(flags)
    case "add-model":
      return commandAddModel(flags)
    case "add-shared-model":
      return commandAddSharedModel(flags)
    case "set-provider":
      return commandSetProvider(flags)
    case "set-model":
      return commandSetModel(flags)
    case "set-shared-model":
      return commandSetSharedModel(flags)
    case "remove-provider":
      return commandRemoveProvider(flags)
    case "remove-model":
      return commandRemoveModel(flags)
    case "remove-shared-model":
      return commandRemoveSharedModel(flags)
    case "help":
    case undefined:
      console.log(USAGE)
      return
    default:
      throw new CliError(`未知命令 "${command}"\n\n${USAGE}`)
  }
}

function main() {
  try {
    run(process.argv.slice(2))
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`✗ ${error.message}`)
      process.exit(1)
    }
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
