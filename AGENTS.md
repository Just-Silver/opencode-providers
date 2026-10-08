# 项目定位

`opencode-providers`：给 opencode 补上 **models.dev 目录里没有的供应商**。
一份自维护注册表（**按供应商分文件**：`registry/index.json` manifest + `registry/providers/<id>/{provider,models}.json` + `registry/models/<lab>/<model>.json`，GitHub raw 托管；插件运行期拉取并聚合成一份）+ 一个 opencode 插件，实现**零 `opencode.json`** 接入。

现状：`0.3.2` 是**正式版**（npm `latest`，OIDC 发布 + provenance）；预发布在 `next`。

> **职责**（AI agent）：硬约束 / 坑 / 命令 + 文档地图。完整流程步骤见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

# 语言规则

- 全程中文沟通；`git commit` 用中文。

# 结构硬约束

- **只通过 npm 包分发**（`opencode.json` 的 `plugins` / `opencode plugin add`），**没有安装脚本**。
  本地开发：`plugins` 里给一个**绝对路径目录**（须含 `index.ts`+`tui.ts`）→ opencode 按「本地目录插件」处理，
  改源码被文件监视热重载（`packages/core/src/plugin/supervisor.ts:254` `path.isAbsolute` → `{type:"local"}`；
  `module.ts:94-97` 目录走 `Host.resolve({directory})`，`host.ts:17-43` 解析 `server`/`tui`）。
- **仓库内的源码故意放在 `plugin/opencode-providers/`（不在 `.opencode/plugins/` 下）**：
  `.opencode/plugins/` 是自动发现根，放在那里会让「在仓库里跑 opencode」与 npm 那份**同 id 相撞**，
  supervisor 保留首个、把后来者标成 `failed`（`Duplicate plugin ID: opencode-providers`），
  在 `/plugins` 面板显示一条失败的 red row（功能其实正常，但很误导）。
  证据：`packages/core/src/plugin/supervisor.ts:96-111`（`failures` 里塞入重复项，`state.status="failed"`）。
- 同目录**双入口**（`packages/plugin/src/host.ts:43` 的 `server: entry(["server",""])` / `tui: entry(["tui"])`）：
  - `index.ts` = **server 入口**：拉注册表 → 注册 integration / provider / models。**不得触碰 `context.ui`**
  - `tui.ts` = **TUI 入口**：只注册 `/connect-providers` 命令与交互（**不读注册表**，命令里读服务端已注册的 integration）；
    图层必须写 **`mode: "global"`**（图层 mode 默认 `"base"`，而提示框 push 的是 `"composer"`／补全时 `"autocomplete"`
    → 漏了就会"插件 active 但看不到命令"；证据：`packages/tui/src/context/keymap.tsx:209-214` + `component/prompt/autocomplete.tsx:474-483`）
- **server 入口不得 import 任何 `@opencode/*`（实测踩坑，opencode 2.0.24）**：`@opencode/plugin` 只注入给 TUI 入口，
  server 入口（本地目录或 npm 包都一样）拿不到它——包内也没声明该依赖，消费方装不到——
  会以 `ResolveMessage: Cannot find package '@opencode/plugin'` 加载失败（`/api/plugin` 里 `status: failed`）。
  `@opencode/plugin/tui` **是**注入的，TUI 入口照常 import。运行时需要的都是普通值：
  `Plugin.define` 是恒等函数（`export default { id, setup }`）、`Provider.ID.make`/`Integration.ID.make` 就是字符串、
  `Provider.Info.empty(id)` = `{ id, name: id, activation: "auto", package: "" }`。类型可用 `import type` 或本地结构化接口。
- 相对导入必须带显式扩展名（`./registry/schema.ts`）：server 插件由 bun 逐文件加载，TUI 侧同样；
  纯逻辑模块也要能被 `node --test` 原生 TS 解析
- `registry/` 与 `view/` 视为插件子模块，只被两个入口 import
- **有根 `package.json`（npm 包形态）**：`type: module`；`exports["./server"]` / `["./tui"]` / `["./rpc"]`；`files` 白名单；
  `publishConfig.tag = next`。使用方在 `plugins` 里写 `"@justsilver/opencode-providers"`（或 `opencode plugin add …`）
- **TUI 入口不写 JSX（故文件名是 `tui.ts` 而非 `.tsx`）**：JSX 会让 Bun 注入 `@opentui/solid/jsx-runtime`，
  而运行时重写器只重写「源码文本里可见」的 import → 配置安装（`node_modules`）下会命中插件自带的 Solid 副本，
  变成**第二套响应式图**（现象：只渲染首帧、之后永不刷新）。不写 JSX 就完全绕开；也**不要**声明
  `solid-js` / `@opentui/*` 的 `peerDependencies`（npm 会自动装副本进插件的 `node_modules`）

# 设计约束（已定）

- **只做 A 方案**：注册表是模型与参数的**唯一事实源**；插件不做推断、不调供应商 `/v1/models`、不覆盖
- **认证只声明 `key`**：不声明 `env` 方法（opencode 的 env 是静默旁路，且不在 `/connect` 里展示）
- provider 用 **`activation: "auto"`**：拿到凭据才出现在 `/models`，因此注册表可以放心放多家供应商
- **凭据不归本项目管**：key 存 opencode 自己的 SQLite；注入靠 `provider.integrationID === integration.id`
- **命令名 `/connect-providers`**：独立命名，不与内置 `/connect` 冲突（同名会并列出现两行，属未定义行为）
- 注册表用 `schemaVersion` 解耦：改注册表**不需要**发插件版本；不匹配的版本整份拒绝
- 拉取：默认 6h TTL + `ETag` + 失败沿用旧缓存。缓存落在 `ctx.storage`（= 全局 `opencode.db` 的 `kv` 表，宿主给键加
  `plugin:<id 的 hex>:` 前缀，跨 location 共享）；**键含 URL**（`registry-cache:<url>`），换地址即刻重拉；
  **没有后台定时器** —— 只在插件 `setup()`（= opencode 启动 / 安装换版本 / 配置变更热重载 / 重启）时判定一次 TTL
  （内核 models.dev 才是"每 5 分钟轮询"，别把两者混了）
- 参数写全，不许猜：`limit`/`cost`/`tools`/模态/`compatibility`/`variants` 都由注册表给出
- **注入链路**：`kv` 缓存 → `setup()` 解析 → `editor.add({ info, models })` 写进内核 `Provider.Service` 内存 records
  → `Provider.snapshot()` 按 activation/凭据过滤 → `Model.available()` → `/api/model`。**内核从不读我们那条 kv 行**，
  它只是防重复拉取的私有缓存；清掉它只会引起一次重拉，不会改已注册的模型列表
- **换注册表来源**不用改源码：配置里写成对象条目传 options
  （`"plugins": [{ "package": "@justsilver/opencode-providers", "options": { "registryUrl": "…" } }]`；
  插件读 `ctx.options.registryUrl`，有单测钉住。`schema/src/config/plugin.ts:6-11` 证明 config 条目支持 options）

# 发版

- **版本单一事实源 = `package.json` 的 `version`**：CI/CD 用 `node scripts/changelog.mjs check [--tag vX.Y.Z]` 校验
  `tag == package.json == CHANGELOG 顶部版本小节` 三处一致，不一致**不产生任何发布动作**；
  Release 正文用 `node scripts/changelog.mjs notes --out …` 从 CHANGELOG 该小节截取（不是 `git log` 堆砌）
- **预发布优先**（`publishConfig.tag = next`），正式版只能手动发 `latest`；认证走
  **npm Trusted Publishing（OIDC，`id-token: write`，无长期 token）**，但**包必须已存在** → **首个版本要人工发一次**
- 预检用 `npm pack --dry-run`，**别用 `npm publish --dry-run`**（后者会因「版本已存在」而报错，哪怕只是想预检）
- `.github/workflows/ci.yml` 在 push main / PR 上跑「版本一致性 + `node --test` + 注册表 validate/check」；
  **没有 lint/typecheck/formatter**，改完必须自己跑单测 + esbuild（见下）
- 使用方安装/升级（`opencode plugin` 子命令实测存在，`packages/cli/src/commands/commands.ts:269-311`）：
  `opencode plugin add @justsilver/opencode-providers` / `opencode plugin update <配置里那串原样>` / `opencode plugin remove …`
- **完整发版流程**（`npm version`、打 tag、Actions 勾选、人工首发 runbook、tarball 传播延迟）
  见 `CONTRIBUTING.md`「发版」与 `docs/npm-distribution-and-testing.md`

# 运行与验证

- 单测：`node --test`（Node ≥ 24；含 `scripts/changelog.mjs` 的工具测试与
  `tests/setup.test.ts` —— 走**真 server 入口 + 真注册表 + 假 ctx** 钉住「拉到什么就注册什么」的链路）
- **铁律：改注册表数据不许改任何测试代码**（2026-10-08 用户明确要求）。skills 的日常操作
  （新增/删除供应商、模型、共享模型）必须是**纯数据改动**，`node --test` 必过。
  因此**测试里禁止写死**任何随仓数据（供应商 id、`deepseek-v4.1-flash`、`keyLabel` 文案、模型数、共享模型数、
  `keyLabel` 断言 —— 注意 CLI 根本写不了 `keyLabel`，经 skills 新建的供应商**没有**它）。
  期望值一律从 `tests/helpers/shipped.ts`（`registryView(root)`，只读）推导；
  `tests/registry-cli.test.ts` 在临时副本里播种**固定锚点**供应商（`zz-anchor`：`anchor-shared` 只写 base /
  `anchor-override` 覆盖 modelID / `anchor-inline` 内联 / 共享模型 `anchor/base-model`），
  所以 CLI 测试的操作对象与随仓数据无关。
  **已实测 11 个场景全部 99/99 零改动**：+4 家供应商（无 `keyLabel`/`base` 引用/多模态）、
  批量 +4 模型、孤儿共享模型（先建后引的中间态）、孤儿→被引用、改名+改 limit（provider/model/共享模型）、
  共享模型清空、重建孤儿、批量删模型、删供应商、删到只剩 2 家 / 1 个模型。
  注意 Node 原生 TS 只擦除类型：**class 成员修饰符（`private`）和注释里的 `*/` 都会解析失败**，故 helper 用闭包工厂。
  另：**聚合是按需拉取**，只拉被 `base` 引用的共享模型 —— 别断言「孤儿共享模型出现在 `registry.models`」；
  `add-shared-model` 后的孤儿态是合法中间态，测试要先清孤儿再断言 `check` 全绿
- 真机冒烟（HTTP，不需要 TUI）：`node scripts/smoke-api.mjs --list` / `node scripts/smoke-api.mjs`
  （鉴权自动读 `~/.local/state/opencode/service.json`；`models` 场景会写一条临时凭据再删，只碰「当前无凭据」的 supplier）
- 入口打包/语法检查（esbuild，`Done in` 即通过；TUI 入口的注入包必须标 `--external`，否则解析失败 exit 1）：
  ```
  npx --yes esbuild plugin/opencode-providers/index.ts --bundle --platform=node --format=esm --outfile=dist/providers-server.js
  npx --yes esbuild plugin/opencode-providers/tui.ts --bundle --platform=node --format=esm --external:@opencode/plugin/tui --outfile=dist/providers-tui.js
  ```
- npm 打包预检（不发布）：`npm pack --dry-run`（确认 `plugin/**/*.ts` + CHANGELOG 进了 tarball）
- **本地目录插件**通常无需重启：改源码被文件监视热重载（实测 `/api/plugin` 立刻变为 `status=active`）；必要时再 `opencode service restart`
- **验证注册真的生效**：一条命令 `node scripts/smoke-api.mjs`；手工证据链（`/api/plugin|integration|model|provider`
  + 临时凭据）与「怎么判定插件加载了」见 `CONTRIBUTING.md`
- 注册表没生效时先看 `/api/plugin` 的 `state.status`，再看 server 日志里的 `failed to load plugin ... cause=`
- **同一插件 id 被发现两次就会有一条 `failed`**：npm 包（或本地目录插件）与某个项目的 `.opencode/plugins/` 里那份撞名时，
  按 boot 顺序**首见者生效**、后者在 `/api/plugin` / `/plugins` 面板里显示 `failed` + `Duplicate plugin ID: <id>`。
  本仓源码已移出 `.opencode/plugins/` 从而不会自撞；排查别人的项目时按这条判据看
- **本地开发**：`plugins` 指向工作树绝对路径目录（见「结构硬约束」）→ 改源码自动热重载，无需发布/安装；
  与 npm 包**同 id 不可并存**（同时配 = 一条 `failed`）
- **注册表 id 与 `opencode.json` 里 `providers.<id>` 撞名时会「各管一半」**：integration 的 `metadata.source`/`keyLabel`/`methods` 用注册表那份，
  但 provider 的 `activation` 与 `settings.apiKey` 仍是配置那份（`enabled` + 明文 env key）⇒ 模型无凭据也可见、`auto` 语义失效。
  要完全走注册表就删掉配置里那一块；只想用 `{env:…}` 就别写进注册表 —— 同 id 两边只留一边
- 换注册表 URL / 删注册表条目后要**触发一次重载**才生效（改文件、重装、重启）；URL 404 时插件沿用旧缓存，但**新 key 无缓存时 setup 会直接 return**（插件 active 却注册 0 条）
- **强制刷新必须带当前 location**（`view/connect.ts` 的 `doRefresh` 传 `{ location: { directory } }`）：
  **provider/model 注册是按 location 隔离的**，不带 location 的 RPC 只刷服务端的**默认目录**（`/api/location` 返回的那个），
  用户所在目录的注册一直停在旧状态。现象：`/api/model`（默认目录）里有新模型、选择器里没有。
  排查口径：**按自己所在目录的 location 调 `/api/model`**，与默认目录逐一对比 —— **两边模型数不同就是这个**。
  客户端刷新后还要**主动失效并重取 `integration`/`model`/`provider` 三件套**（`reloadCatalog`），不能只刷 integration。
  注：服务端事件链**是通的**（`provider.updated` / `model.updated` 都会发），但**事件带的是被调用的那个 location**，
  所以关键是 location 对齐，而不是等事件（2026-10-08 实测纠正过一次错误结论：曾误判为「事件链不发」）
- 查注册表缓存（只读，最安全；`console.*` 不进 opencode 日志）：
  ```
  node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.USERPROFILE+'\\.local\\share\\opencode\\opencode.db',{readOnly:true});const ns='plugin:'+[...'opencode-providers'].map(c=>c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+':';for(const r of db.prepare('SELECT key,value FROM kv WHERE key LIKE ?').all(ns+'%')){const v=JSON.parse(r.value);console.log(r.key.slice(ns.length),'|',new Date(v.fetchedAt).toISOString(),'|',v.etag)}"
  ```

# 收尾纪律（踩过的坑）

- **临时探针必须双向收尾**：探针法（临时注册表 + 改 `DEFAULT_REGISTRY_URL`）除了把源码还原，
  还要删掉它留下的 `kv` 行（键 `…:registry-cache:<探针 URL>`），否则永久残留一条死行；
  更干净的做法是用 `options.registryUrl`（见「设计约束」）而不是改源码
- **临时文件别留在用户机器上**：验证脚本/落盘的 JSON/备份文件用系统临时目录（本机 `%TEMP%\opencode`），
  收尾时清掉；只保留明确告知过的配置备份
- **不留死代码**：声明了却没人用的 export/可达不到的钩子都算（本项目无 lint，靠自觉 + 单测）。
  删钩子前先在 opencode 源码里确认它真的不可达（例：`options.registryUrl` 经 config 对象条目**可达** → 留下并补单测）

# 技能（`.opencode/skills/`）

- `opencode-providers-registry` —— 维护分文件注册表（`registry/index.json` manifest + `registry/providers/<id>/{provider,models}.json` + `registry/models/<lab>/<model>.json`）：**lab 模型层 + 来源三选一**——`add-provider`/`add-model` **必须**声明模型来源 `--lab <lab>`（建家族 canon `models/<lab>/<model>.json`）/ `--base <lab>/<model>`（复用，**新增前先 `search` 命中就用**）/ `--inline`（本家独有；**独家代理 ≠ 本家独有**）；**没命中时技能先用 `question` 问「家族标签 lab」**（不许自己编 lab、不许默认内联）+ **改**（`set-provider`/`set-model`/`set-shared-model`，字段补丁 + `--unset`）+ **删**（`remove-provider`/`remove-model`/`remove-shared-model`，带安全约束：不许删空 provider、不许删仍被引用的共享模型；**删后自动清理无人引用的 canon**）、
  **最小字段铁律**（严格只写最小字段，其余不写；provider 层 **override-only**——`--lab` 时只写 `base`（+ 可选 `modelID`），参数进 canon；模型**能力** `input` 由技能用多选问出后再写）、协议 → package（`/v1/chat/completions` /
  `/v1/responses` / `/v1/messages` 三种形态）、**一次性用 `question` 收集信息**、改完必须 push + 触发重载 + 验证。
  **agent 禁止直接读整份注册表**（会随供应商/模型增长而变大）：查/改全走随技能 CLI
  `.opencode/skills/opencode-providers-registry/scripts/registry.mjs`（入口 + `scripts/lib/` 子模块：`cli`/`store`/`spec`/`report`/`commands-{read,write}`）
  （`list` / `search` / `show` / `validate` / `check` / `sync` / `add-*` / `set-*` / `remove-*`），写命令落盘前先组装 +
  过 `parseRegistry` 校验，冲突（重复供应商 id / 重复模型 key / 占用 baseURL / 悬空 `base`）直接报错、不写文件；路由 A/B 的 `question` 模板在 SKILL.md 里**原样照搬**，路由 C 用**动态选项**（把 `search` 命中填进选项）。
  `list`/`search`/`show` 会暴露**顶层共享模型**（含未被引用的），`check` 做更全体检（悬空引用/孤儿/**参数完全相同的两个 canon（重复家族）**/重复 baseURL/`input` 缺 text/空目录，`--strict` 时提醒也算失败）。
  `revision` = `providers/**` + `models/**` 全部文件按 posix 相对路径排序后的确定性哈希；写命令自动重算并重写 `index.json`，手改子文件后用 `sync` 补齐。
  由 `tests/registry-cli.test.ts` 钉住（分文件读写 / `sync` / 冲突 / Windows 非法路径段 / **来源三选一（`--lab`/`--base`/`--inline`）** / 复用 / set-* / remove-* / **删除自动清理 canon** / check）。
  脚本用 Node（`.mjs`）而非 PowerShell：CI 在 ubuntu 跑 `node --test`，且校验逻辑是 TS（复用 `registry/schema.ts`，单一事实源）。
- `.opencode/skills/` **不是**插件发现根（发现器只扫 `<config>/plugin`、`<config>/plugins`），放在这里安全。
- 改这个技能要先做**基线对比测试**（无技能跑一遍看偏差 → 写/改技能 → 有技能再跑一遍），
  已实测的偏差是「自行加 `keyLabel`、把参数硬抽到顶层 `models` + `base`」。
  **2026-10-07 复测（新增 / 改 / 删 / 复用共享模型）**：无技能基线会直接 `Read` 全部 `registry/**`（`index.json` + 各 `providers/*` + `models/*`）、
  手改 JSON 并自己推算 `revision`；有技能时 **0 直读、全程走 CLI**（连「改名」也用 `remove-*` + `add-*`）。
  基线另暴露：CLI 最小字段铁律下「改名」会丢掉 `keyLabel` 等历史字段 → 技能已注明「停下向用户说明、别手改」。
  **2026-10-08 复测（新增「无 canon 的模型」）**：无技能基线**不问 lab、直接内联**（正是「canon 层被架空」的入口）；
  有技能时**先问「家族标签 lab」再 `--lab` 建 canon**、`check --strict` 全绿。

# 文档地图

唯一索引：写内容前先查此表；新文档必须在同一次改动里登记（一行一篇，只登记顶层入口）。

| 文档 | 负责 | 不写 |
|---|---|---|
| `README.md` | 使用者：安装 / 使用 / 疑难解答 | 开发 / 架构 / 发版 |
| `CONTRIBUTING.md` | 贡献者：本地开发 / 架构 / 测试 / 注册表维护 / 发版 | 使用教程 |
| `AGENTS.md` | agent：硬约束 / 坑 / 命令 + 本表 | 完整流程步骤（链 CONTRIBUTING） |
| `docs/opencode-commands.md` | opencode 命令系统（通用知识） | 本插件用法 |
| `docs/opencode-connect-custom-provider.md` | opencode `/connect` 与自定义供应商（通用知识） | 本插件安装 |
| `docs/opencode-plugin-provider-no-config.md` | 本插件「零配置」设计与证据 | opencode 通用教程 |
| `docs/npm-distribution-and-testing.md` | 本项目 npm 分发 / 测试实践 | 注册表数据 |
| `docs/specs/`、`docs/plans/` | 历史设计 / 计划（只读冻结） | 新内容 |
