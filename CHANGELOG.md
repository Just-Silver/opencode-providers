# Changelog

本项目所有值得注意的变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- `/connect-providers` 弹窗新增**强制刷新**：footer 动作 + 快捷键 `mod+r`（macOS `Cmd+R`，Windows/Linux `Ctrl+R`），
  经 server RPC（纯 JSON Schema）绕过 6h TTL 重拉注册表并 `provider`/`integration` `reload()`；上游不可达时保留原有列表并报错
- `tests/setup.test.ts` 新用例：钉住 `ctx.options.registryUrl` —— 配置里把 `plugins` 写成对象条目传 `options` 即可换注册表地址，
  不用改源码（`schema/src/config/plugin.ts` 证明 config 条目支持 `options`）

### Changed

- **破坏性变更：注册表改为按供应商分文件 + 插件运行期聚合。** 源 = `registry/index.json`（manifest：`schemaVersion`/`revision`/`providers`）
  + `registry/providers/<id>/{provider,models}.json` + 顶层共享模型 `registry/models/<lab>/<model>.json`；插件拉 manifest、按 `revision`
  决定是否重拉子文件，聚合成旧的 `{schemaVersion, models, providers}` 后写 kv（TTL / `ETag` / 失败沿用缓存语义不变）。
  插件默认地址改为 `.../registry/index.json`；旧的单文件 `registry/registry.json` 与 `registry/registry.schema.json` 已删除。
  - **旧版本（≤ 0.1.0）拉旧地址会 404** → 沿用本地缓存（列表不清空，但不再更新），需升级到本版才能继续拿到更新。
- 维护脚本（`.opencode/skills/.../scripts/registry.mjs`）改写为操作分文件：新增 `sync`（重算 `revision` + 重写 `index.json`）、
  `--root <注册表目录>`（原 `--registry`），`add-shared-model` 改 `--lab` + `--key`；`base`/`lab`/`key`/`id` 逐段校验（拒 Windows 非法字符）
- 清理死代码：去掉 `INTEGRATION_SOURCE` / `DEFAULT_TIMEOUT_MS` 的多余 `export`；删除 `/connect-providers` 里
  不可达的 OAuth「Sign in required」分支（注册表只声明 `key`，pending 连接不可能出现）
- 文档按源码复核：注册表缓存的**位置/TTL/重拉条件**（全局 `kv` 表、键含 URL、无后台定时器）、
  **模型列表进 `/model` 的四层链路**、opencode 内核 TTL 对照；README 修正 `tui.ts` 文件名与「最迟 6 小时自动跟上」的错误说法

## [0.1.0] - 2026-10-07

> 首个**正式版**（由 `0.1.0-beta.0` → `0.1.0-beta.2` 三个预发布版本稳定而来）；npm 的 `latest` 指向它。

### Added

- 自维护注册表 `registry/registry.json` + `registry/registry.schema.json`：共享 `models` 表 + provider `base` 引用/覆盖，
  带 `schemaVersion` —— 改数据**不需要**发插件版本
- 注册表收入两家真实供应商：**Command Code**（`https://api.commandcode.ai/provider/v1`）与
  **R4 Coder**（`https://api.r4.codes/v1`）。二者共享 `deepseek-v4.1-flash`
  （context 1048576 / output 393216，`reasoningEffort` 变体 low/high/max）；Command Code 用 `modelID` 覆盖成 `deepseek/deepseek-v4.1-flash`
- server 入口：按注册表注册 integration（只声明 `key` 方法）与 provider（`activation: "auto"`）及其模型；
  拉取 6h TTL + `ETag` + 失败沿用旧缓存（`ctx.storage`）
- TUI 入口 `/connect-providers`：选供应商 → 贴 API Key / 切换账号，与内置 `/connect` 共用同一张凭据表
- 两种安装方式：npm 包（`"plugins": ["@justsilver/opencode-providers"]`）与安装脚本（整目录复制到
  `~/.config/opencode/plugins/`，支持 `--local` / `-Local` 从工作树部署）
- 预发布优先的发版流水线：CD 走 OIDC（自动签名 provenance），预发布发 npm 的 `next`；
  正式版必须**手动** Run workflow 勾 `publish` + `stable`（该次运行发布到 `latest` 并补 tag + GitHub Release）
- `.opencode/skills/opencode-providers-registry`：维护注册表的技能（两条路由 + 最小字段铁律 + 协议 → package）

### Fixed

- **`/connect-providers` 在输入框里"看不见"**：命令图层补 `mode: "global"`（图层默认 `base`，而提示框 push 的是
  `composer`／补全时 `autocomplete` → 不可达，命令不进补全列表）
- 仓库自身不再是插件发现根（源码移到 `plugin/opencode-providers/`），避免在仓库里跑 opencode 时与全局安装**同 id 相撞**
  （supervisor 会把后者标成 `failed` + `Duplicate plugin ID`）

### Changed

- 注册表移出仓库根：`registry.json` → `registry/registry.json`（`$id` 同步）；插件默认拉取地址与**缓存键**同步改为含 URL，换地址立即重拉

## [0.1.0-beta.2] - 2026-10-07

### Added

- 注册表收入两家**真实供应商**：**Command Code**（`https://api.commandcode.ai/provider/v1`）与
  **R4 Coder**（`https://api.r4.codes/v1`），共享 `deepseek-v4.1-flash` 参数
  （context 1048576 / output 393216，`reasoningEffort` 变体 low/high/max）；
  Command Code 用 `modelID` 覆盖成 `deepseek/deepseek-v4.1-flash`，R4 Coder 用默认（= map key）
- `tests/registry.test.ts`：对随仓注册表断言这两家、共享 `base` 与 `modelID` 覆盖（CI 会跑）

### Changed

- **注册表挪出仓库根目录**：`registry.json` / `registry.schema.json` →
  `registry/registry.json` / `registry/registry.schema.json`；插件默认拉取地址同步为
  `…/main/registry/registry.json`。旧版本（beta.0/beta.1）拉旧地址会 404 → **沿用本地缓存**（不会清空列表，但不再更新），需升到本版
- 注册表缓存按 URL 区分（`registry-cache:<url>`）：换 URL 不再等 TTL 就重新拉取

## [0.1.0-beta.1] - 2026-10-07

### Fixed

- **`/connect-providers` 在 TUI 里"看不见"**：命令图层漏写 `mode`，默认落到 `base`；而提示框打开时推的是 `composer`、
  补全菜单可见时再推 `autocomplete` → 该图层不可达，命令不会进入补全列表（插件却是 `active`）。
  改为 **`mode: "global"`**（内置插件的 slash 命令都这么写），并加 `palette: true` 让命令面板里也能搜到。
  证据：`packages/tui/src/context/keymap.tsx:209-214`、`packages/tui/src/component/prompt/autocomplete.tsx:474-483`

### Changed

- `docs/opencode-commands.md` 补「漏写 `mode: \"global\"` → 命令注册了但看不见」的坑、证据与触发方式；
  `README.md` 补 `/connect-providers` 的触发方式（补全菜单选中即执行／命令面板可搜）

## [0.1.0-beta.0] - 2026-10-07

> 首个**预发布**版本：先发到 npm 的 `next` dist-tag 试装，稳定后再发 `latest`。
> 装上后不需要写 `opencode.json`，在 `/connect-providers` 里贴一次 API Key 即可用。

### Added

- `registry.json` + `registry.schema.json`：自维护供应商注册表（共享 `models` 表 + provider `base` 引用 + 覆盖），带 `schemaVersion`
- server 入口 `plugin/opencode-providers/index.ts`：拉注册表（6h TTL + `ETag` + 失败沿用旧缓存）→ 注册 integration（`key`）与 provider（`activation: "auto"`）及其模型；**不 import 任何 `@opencode/*`**
- TUI 入口 `plugin/opencode-providers/tui.ts` + `view/connect.ts`：`/connect-providers` 命令（选供应商 → 贴 API Key / 切换账号），与内置 `/connect` 共用同一张凭据表。**无 JSX、不依赖 Solid**，因此 npm / 配置安装不会踩「双 Solid 运行时」
- `registry/` 纯逻辑：schema 校验 / `Model.Info` 映射 / 拉取缓存；`node --test` 覆盖（含「随仓注册表能通过校验」）
- `package.json`：npm 包形态（`type: module`；`exports["./server"]` / `["./tui"]`；`files` 白名单；`publishConfig.tag = next`），可 `"plugins": ["@justsilver/opencode-providers"]` 配置安装
- `install.sh` / `install.ps1` / `uninstall.sh` / `uninstall.ps1`：脚本安装（最新 Release 优先、回退 `main`、同文件系统原子替换）；`--local` / `-Local` 从工作树部署
- `.github/workflows/ci.yml`（跑 `node --test` + 版本一致性）与 `release.yml`（tag 触发；预发布发 `next`，正式版必须手动勾选才发 `latest`；Release 内容取自本文件）

### Changed

- 插件源码从 `.opencode/plugins/opencode-providers/` 移到 `plugin/opencode-providers/`：仓库自身不再是插件发现根，避免在仓库里跑 opencode 时与全局安装的同 id 副本相撞（`Duplicate plugin ID` → 面板里一条 `failed`）
- 安装后**通常无需重启**（插件目录被文件监视热重载），不再要求 `opencode service restart`

[Unreleased]: https://github.com/Just-Silver/opencode-providers/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Just-Silver/opencode-providers/releases/tag/v0.1.0
[0.1.0-beta.2]: https://github.com/Just-Silver/opencode-providers/releases/tag/v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/Just-Silver/opencode-providers/releases/tag/v0.1.0-beta.1
[0.1.0-beta.0]: https://github.com/Just-Silver/opencode-providers/releases/tag/v0.1.0-beta.0
