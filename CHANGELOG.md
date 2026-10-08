# Changelog

本项目所有值得注意的变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- 技能 CLI：`list` / `list --json` 的**顶层共享模型引用方按供应商去重**（同一家多个模型引用同一 canon 时，不再出现 `r4-coder, r4-coder`）。
- 技能 CLI：`search` 输出给**供应商 id/名称命中**加标记 `〔供应商 id/名称命中〕`，与「仅其名下模型命中」区分。
- 技能 CLI：`remove-shared-model` 的**拒绝文案**改为**推荐 `remove-model`**，并说明「纯 `base` 引用直接 `--unset base` 会留下无 limit 的非法模型」。
- 技能：澄清「**精确命中不用问**，直接 `--base`；**模糊命中（多个/相似）**才用 `"multiple"` 的 `question` 二次确认」；「改名」限定为 **id/key（标识）**（**显示名**走 `set-provider --name` / `set-model --model-name`）；判定供应商是否存在**用 `show <id>`**（`search` 是宽松召回，同 token 会假阳性）；`set-model` / `set-shared-model` **不能补 `variants`**。
- 技能 CLI：`search` 改为**宽松匹配（召回优先）**——归一化（大小写、`. _ / \` 与 `-` 等价、词序无关、忽略版本数字）+ token，**一次搜索可能召回多个候选**。
- 技能：命中**分档**——归一化后相等才 `--base`；**召回多个 / 相似但不同**（如 `glm-5` vs `glm-5-air`）→ 用 `"multiple": true` 的 `question` 把候选动态列出让用户**二次确认**（**模糊命中不标「推荐」**）；无命中的「家族标签（lab）」题**动态列出已有 lab** 且**支持多选**；并明确**跨步骤不得沿用上一步的 lab**。

## [0.3.2] - 2026-10-08

首个稳定版（并入 `0.3.2-beta.0` / `0.3.2-beta.1` 的全部内容）。

### Fixed

- **强制刷新未携带 location → 模型列表不更新**：provider / model 注册**按 location 隔离**（同一个 `/api/model` 按请求目录返回不同结果）。`doRefresh` 调 RPC 时没传 location，于是只刷到服务端**默认目录**，用户所在目录的注册一直停在旧状态。改为 RPC 调用**带上当前 location**（`{ location: { directory } }`）；客户端刷新后同时失效并重取 `integration` / `model` / `provider`（`reloadCatalog`）。

### Changed

- **技能 CLI：`add-provider` / `add-model` 现在必须声明模型来源（破坏性）**——`--lab <lab>`（建家族 canon `registry/models/<lab>/<model>.json`，参数写进 canon、provider 层只写 `base`）/ `--base <lab>/<model>`（复用已有 canon）/ `--inline`（本家独有，必须自带 limit）。**取消「默认内联」**：不给来源直接报错。判据是「能不能说出造它的 lab」，**独家代理 ≠ 本家独有**。技能在 `search` 没命中任何 canon 时会先问「家族标签（lab）」。
- 注册表数据：`kimi-k3` 提升为共享模型 `kimi/kimi-k3`，`r4-coder` 改为 `base` 引用。

### Added

- 技能 CLI：`--lab-key`（canon 文件名与 provider key 可不同）；`check` 新增「参数完全相同的两个 canon（重复家族）」提醒；`remove-provider` / `remove-model` 后**自动清理无人引用的 canon**（并清空空 lab 目录）。
- （`0.3.2-beta.0`）注册表维护 CLI：复用共享模型（`list`/`search`/`show` 暴露顶层共享模型）、`set-*` 字段补丁 + `--unset`、`remove-*` 安全约束、`check [--strict]`、CLI 拆分 `scripts/lib/` 子模块；CI 增 `registry.mjs check --strict`。

## [0.3.2-beta.1] - 2026-10-08

### Fixed

- **强制刷新未携带 location → 模型列表不更新（真正的根因）**：provider / model 注册**按 location 隔离**
  （同一个 `/api/model` 按请求目录返回不同结果）。`doRefresh` 调 RPC 时没传 location，于是只刷到服务端
  **默认目录**（`/api/location` 返回的那个），用户所在目录的注册一直停在旧状态 —— 现象是「默认目录下
  `/api/model` 有新模型、模型选择器里没有」。改为 RPC 调用**带上当前 location**（`{ location: { directory } }`），
  刷新与随之发出的事件都落在用户所在目录。
  另：客户端刷新后同时失效并重取 `integration` / `model` / `provider`（`reloadCatalog`），不再只刷 integration。
  （`0.3.2-beta.0` 只做了后者，**未修好**。）

## [0.3.2-beta.0] - 2026-10-08

### Added

- 注册表维护 CLI（`.opencode/skills/opencode-providers-registry/`）扩展：
  - **复用共享模型（路线 C）**：`list`/`search`/`show` 现在暴露**顶层共享模型**（含未被引用的），新增模型前先 `search`，命中即用
    `add-*/--base <lab>/<model>` 复用（不再逐项重问 limit/变体/模态）；`add-*` 在参数与某共享模型相同时还会打一行软提示。
  - **改**：`set-provider` / `set-model` / `set-shared-model`——字段补丁（只改传入字段）+ `--unset a,b` 清空。
  - **删**：`remove-provider` / `remove-model` / `remove-shared-model`——带安全约束（不许删空 provider、不许删仍被 `base` 引用的共享模型）。
  - **体检**：`check [--strict]`——揪出悬空 `base` 引用（会让运行期整家跳过）、孤儿共享模型、内联与共享重复、重复 baseURL、`input` 缺 text、空目录。
  - CLI 拆分为入口 + `scripts/lib/` 子模块（`cli`/`store`/`spec`/`report`/`commands-{read,write}`），避免单文件膨胀。
- CI 增加 `registry.mjs check --strict` 一步。

### Changed

- **文档按读者拆分**：`README.md` 收敛为使用者内容（安装 / 使用 / 疑难解答）；新增 `CONTRIBUTING.md` 作开发者入口
  （本地开发 / 架构要点 / 测试与验证 / 注册表维护 / 发版流程 / 约定）；`AGENTS.md` 的发版与验证细节收敛为要点并指向
  `CONTRIBUTING.md`。另按全局「文档标准与约束」落地：`AGENTS.md` 建立「文档地图」（文档 → 负责 / 不写，唯一索引），
  `CONTRIBUTING.md` 只留一行链接；各文档顶部加职责声明；`docs/specs`、`docs/plans` 标记历史冻结。

### Fixed

- **`/connect-providers` 强制刷新后模型 / 供应商列表不更新**（**仅部分修复**）：刷新成功只失效了 `integration` 列表，
  改为同时失效并重取 **`integration` / `model` / `provider`** 三件套（`reloadCatalog`）。
  ⚠️ **本版没真正修好**：真根因是 RPC 未携带 location（见 `0.3.2-beta.1`）。
  本版残留的错误结论是「服务端事件链不发 `model.updated`」——实测该事件**会发**，但事件带的是被调用的那个 location。

## [0.3.1] - 2026-10-07

### Fixed

- **`/connect-providers` 强制刷新后列表不更新**：`doRefresh` 刷新成功只调了
  `ctx.data.location.integration.invalidate()`，而 `invalidate` 仅删除 sync 标记、**不会重新拉取**，`list()`
  读到的仍是旧的客户端缓存（此时服务端其实已注册新供应商）→ 重开的弹窗还是旧列表。
  改用与其它操作一致的 `reloadIntegrations()`（`invalidate` + `await sync`），刷新后重开的列表与服务端
  `/api/integration` 一致。证据：`packages/client/src/solid/data.ts` 的 `locationResource`
  （`list` 读 store、`sync` 才 `sync.run` 拉取、`invalidate` 只 `sync.invalidate`）
- **`/connect-providers` 刷新进度模态看不到**：`refreshWithProgress` 用 `void` 打开 `dialog.alert` 后
  在 `finally` 里立即 `clear()`，刷新一返回就把模态抹掉（快则一帧都看不到）。改为刷新期间不再自行 `clear`：
  列表路径由重开的列表弹窗顶替模态，空态路径（无后续弹窗）显式 `clear`，模态在整个刷新期间保持可见

## [0.3.0] - 2026-10-07

### Added

- `/connect-providers` 账号管理支持**重命名**（`ctrl+r`，弹窗预填当前名称）与**删除**（`ctrl+d`，二次确认后删除）；
  删除最后一个账号时提示 `Disconnected <name>` 并关闭弹窗（该供应商随之从 `/models` 消失）。
  动作触发后**留在弹窗**并原地刷新（与内置 `/connect` 一致）；选中已激活账号不再重复调用 activate
- 强制刷新改为**阻塞式进度模态**（`dialog.alert`，刷新结束自动 `clear`）：刷新期间输入被模态捕获、无法重复触发；
  `forceRefresh` 增加**单飞**（并发调用共用同一次刷新）

### Changed

- **移除安装脚本**：不再提供 `install.sh` / `install.ps1` / `uninstall.sh` / `uninstall.ps1`，本插件**只通过 npm 包分发**；
  本地开发改为在 `plugins` 里指向工作树的**绝对路径目录**（opencode 按「本地目录插件」加载，改完自动热重载）

## [0.2.1] - 2026-10-07

### Fixed

- npm 安装时 `/plugins` 缺少 `rpc` 能力标志：`package.json` 补 `exports["./rpc"]`，让 npm 安装与脚本安装一致
  （强制刷新本身在两种安装下都可用——`features.rpc` 只是展示标志，opencode 未用它做门禁）

## [0.2.0] - 2026-10-07

### Added

- `/connect-providers` 弹窗新增**强制刷新**：footer 动作 + 快捷键 `ctrl+r`（与内置弹窗一致的键位提示），
  经 server RPC（纯 JSON Schema）绕过 6h TTL 重拉注册表并 `provider`/`integration` `reload()`；上游不可达时保留原有列表并报错
- `tests/setup.test.ts` 新用例：钉住 `ctx.options.registryUrl` —— 配置里把 `plugins` 写成对象条目传 `options` 即可换注册表地址，
  不用改源码（`schema/src/config/plugin.ts` 证明 config 条目支持 `options`）

### Changed

- 评审修复：`revision` 对 CRLF/LF 归一（Windows 检出与 Linux CI 算出同一个哈希）；路径段校验收紧（单段字段禁 `/`、`base` 必须恰为 `<lab>/<model>`）；`add-provider` 缺 `--model-name` 时不再拿供应商名顶替模型名；`ctx.rpc` 缺失或刷新失败不再拖垮 provider 注册；强制刷新失败不再谎报「已重载」；stale 回落保留 `warnings`
- 模型**能力**改为技能**多选问出后显式写入**（CLI `--input text,image`）；`tools` 不再写入注册表、默认继承上游
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

[Unreleased]: https://github.com/Just-Silver/opencode-providers/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/Just-Silver/opencode-providers/releases/tag/v0.3.2
[0.3.1]: https://github.com/Just-Silver/opencode-providers/releases/tag/v0.3.1
[0.3.0]: https://github.com/Just-Silver/opencode-providers/releases/tag/v0.3.0
[0.1.0]: https://github.com/Just-Silver/opencode-providers/releases/tag/v0.1.0
[0.1.0-beta.2]: https://github.com/Just-Silver/opencode-providers/releases/tag/v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/Just-Silver/opencode-providers/releases/tag/v0.1.0-beta.1
[0.1.0-beta.0]: https://github.com/Just-Silver/opencode-providers/releases/tag/v0.1.0-beta.0
