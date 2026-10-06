# 项目定位

`opencode-providers`：给 opencode 补上 **models.dev 目录里没有的供应商**。
一份自维护注册表（`registry.json`，GitHub raw 托管）+ 一个 opencode 插件，实现**零 `opencode.json`** 接入。

# 语言规则

- 全程中文沟通；`git commit` 用中文。

# 结构硬约束

- 插件在**安装后**必须是 `plugins/` 的**直接子目录**：`~/.config/opencode/plugins/opencode-providers/`
  （不可再嵌套；直接子 `.tsx` 文件不会被发现，只认 `.ts`/`.js`）
- **仓库内的源码故意放在 `plugin/opencode-providers/`（不在 `.opencode/plugins/` 下）**，安装脚本整目录复制到全局 `plugins/`。
  原因：仓库若自身就是一个发现根，则在仓库里跑 opencode 时仓库副本与全局副本**同 id 相撞**，
  supervisor 保留首个、把后来者标成 `failed`（`Duplicate plugin ID: opencode-providers`），
  在 `/plugins` 面板显示一条失败的 red row（功能其实正常，但很误导）。
  证据：`packages/core/src/plugin/supervisor.ts:96-111`（`failures` 里塞入重复项，`state.status="failed"`）。
- 同目录**双入口**（`packages/plugin/src/host.ts:43` 的 `server: entry(["server",""])` / `tui: entry(["tui"])`）：
  - `index.ts` = **server 入口**：拉注册表 → 注册 integration / provider / models。**不得触碰 `context.ui`**
  - `tui.ts` = **TUI 入口**：只注册 `/connect-providers` 命令与交互；图层必须写 **`mode: "global"`**
  （图层 mode 默认 `"base"`，而提示框 push 的是 `"composer"`／补全时 `"autocomplete"` → 漏了就会"插件 active 但看不到命令"；
  证据：`packages/tui/src/context/keymap.tsx:209-214` + `component/prompt/autocomplete.tsx:474-483`）
- **server 入口不得 import 任何 `@opencode/*`（实测踩坑，opencode 2.0.24）**：脚本安装的本地 server 插件拿不到
  `@opencode/plugin`，会以 `ResolveMessage: Cannot find package '@opencode/plugin'` 加载失败（`/api/plugin` 里 `status: failed`）。
  `@opencode/plugin/tui` **是**注入的，TUI 入口照常 import。运行时需要的都是普通值：
  `Plugin.define` 是恒等函数（`export default { id, setup }`）、`Provider.ID.make`/`Integration.ID.make` 就是字符串、
  `Provider.Info.empty(id)` = `{ id, name: id, activation: "auto", package: "" }`。类型可用 `import type` 或本地结构化接口。
- 相对导入必须带显式扩展名（`./registry/schema.ts`）：server 插件由 bun 逐文件加载，TUI 侧同样；
  纯逻辑模块也要能被 `node --test` 原生 TS 解析
- `registry/` 与 `view/` 视为插件子模块，只被两个入口 import
- **有根 `package.json`（npm 包形态）**：`type: module`；`exports["./server"]` / `["./tui"]`；`files` 白名单；
  `publishConfig.tag = next`。既支持 `"plugins": ["@justsilver/opencode-providers"]` 配置安装，也支持脚本安装
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
- 拉取：默认 6h TTL + `ETag` + 失败沿用旧缓存（`ctx.storage`，按插件 ID 全局命名空间，跨 location 共享）
- 参数写全，不许猜：`limit`/`cost`/`tools`/模态/`compatibility`/`variants` 都由注册表给出

# 发版

- **版本单一事实源 = `package.json` 的 `version`**：CI/CD 用 `node scripts/changelog.mjs check [--tag vX.Y.Z]` 校验
  `tag == package.json == CHANGELOG 顶部版本小节` 三处一致，不一致**不产生任何发布动作**；
  Release 正文用 `node scripts/changelog.mjs notes --out …` 从 CHANGELOG 该小节截取（不是 `git log` 堆砌）
- **预发布优先**：先发 `0.1.0-beta.x` 到 npm 的 **`next`**（`publishConfig.tag = next`），验证后再发正式版
- 流程：整理 `CHANGELOG.md` 的 `[Unreleased]` 成 `## [x.y.z(-beta.n)] - YYYY-MM-DD` → `npm version`（只改 `package.json`）
  → commit → 预发布 push tag `vX.Y.Z-beta.n`（或手动 Run workflow 勾 `publish`）
- **正式版绝不直接发**：`release.yml` 里 push 一个正式 tag 会被拦下；正式版只能手动 Run workflow 且勾 `publish` + `stable`
- 认证走 **npm Trusted Publishing（OIDC，`id-token: write`，无长期 token）**；但**包必须已存在**，
  所以 `0.1.0-beta.0` 需要**人工首发一次**，之后才交给 CD。npm 侧的 Workflow filename 必须与 `release.yml` 同名
- 预检用 `npm pack --dry-run`，**别用 `npm publish --dry-run`**（后者会因「版本已存在」而报错，哪怕只是想预检）
- `install.sh` / `install.ps1` 取源：最新 Release tag 优先，仓库无 Release 时回退 `main`
- `.github/workflows/ci.yml` 在 push main / PR 上跑「版本一致性 + `node --test`」
- 细节与出处见 `docs/npm-distribution-and-testing.md`

# 运行与验证

- 单测：`node --test`（Node ≥ 22 原生 TS strip，零依赖；含 `scripts/changelog.mjs` 的工具测试）
- 真机冒烟（HTTP，不需要 TUI）：`node scripts/smoke-api.mjs --list` / `node scripts/smoke-api.mjs`
  （鉴权自动读 `~/.local/state/opencode/service.json`；`models` 场景会写一条临时凭据再删，只碰「当前无凭据」的 supplier）
- 入口打包/语法检查（esbuild，`Done in` 即通过）：
  ```
  npx --yes esbuild plugin/opencode-providers/index.ts --bundle --platform=node --format=esm \
    --outfile=dist/providers-server.js            # server 入口无外部依赖，不需要 --external
  npx --yes esbuild plugin/opencode-providers/tui.ts --bundle --platform=node --format=esm \
    --outfile=dist/providers-tui.js               # TUI 入口无 JSX，只有 @opencode/plugin/tui（注入）
  ```
- npm 打包预检（不发布）：`npm pack --dry-run`（确认 `plugin/**/*.ts` + CHANGELOG 进了 tarball）
- 安装后**通常无需重启**：覆盖插件目录里的文件会被文件监视热重载（实测 `/api/plugin` 立刻变为 `status=active`）；必要时再 `opencode service restart`
- 验证注册真的生效：**一条命令** `node scripts/smoke-api.mjs`（对照下面的手工证据链）
  ```
  opencode api get  /api/plugin       # 自己那条必须 state.status=active、features.server/tui=true；**多于 1 条 = 同 id 被发现两次**
  opencode api get  /api/integration  # methods 有 key、metadata.source=opencode-providers
  opencode api get  /api/model        # 只列可用 provider 的模型（无凭据时 0 条）
  opencode api get  /api/provider     # activation=auto / package / integrationID / settings.baseURL
  opencode api post /api/integration/<id>/connect/key --data '{"key":"sk-test"}'
  opencode api delete /api/credential/<cred_id>     # 验证完清理，别留假凭据
  ```
- 注册表没生效时先看 `/api/plugin` 的 `state.status`，再看 server 日志里的 `failed to load plugin ... cause=`
- **插件目录被发现两次就会有一条 `failed`**：同一个插件 id 同时存在于全局（`~/.config/opencode/plugins/`）与
  某个项目的 `.opencode/plugins/` 时，按 boot 顺序**首见者生效**、后者在 `/api/plugin` / `/plugins` 面板里显示
  `failed` + `Duplicate plugin ID: <id>`。本仓源码已移出 `.opencode/plugins/` 从而不会自撞；排查别人的项目时按这条判据看
- **安装脚本已端到端实测**：`pwsh -NoProfile -File .\install.ps1` → 无 Release 时解析 `main` → clone → 原子替换 →
  插件被文件监视热重载为 `status=active`、集成仍在；安装后文件是 **CRLF**（`* text=auto` + 本机 `core.autocrlf=true`），
  **Bun 执行正常**（实测 active），只有 `*.sh` 被 `.gitattributes` 固定为 LF（因为要 `curl … | bash`）
- 开发时把工作树部署到全局：`pwsh -NoProfile -File .\install.ps1 -Local` / `bash install.sh --local`（含未提交改动）

# 文档索引（docs/）

- `opencode-commands.md` —— 内置命令 vs 插件命令、同名冲突语义、插件注册命令/对话框的可用 API
- `opencode-connect-custom-provider.md` —— `/connect` 数据来源、凭据存哪/如何注入、目录 TTL、自维护注册表怎么抄 models.dev
- `opencode-plugin-provider-no-config.md` —— 零 `opencode.json` 的证据链、`activation` 语义、模型参数来源与 TTL 参考
- `npm-distribution-and-testing.md` —— npm 包形态/预发布发布策略（OIDC、dist-tag）、TUI 不写 JSX 的根因、
  `scripts/smoke-api.mjs` 冒烟姿势与「怎么判定插件到底加载没加载」（参考 `opencode-goal` 后的结论）
