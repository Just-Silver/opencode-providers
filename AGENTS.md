# 项目定位

`opencode-providers`：给 opencode 补上 **models.dev 目录里没有的供应商**。
一份自维护注册表（`registry.json`，GitHub raw 托管）+ 一个 opencode 插件，实现**零 `opencode.json`** 接入。

# 语言规则

- 全程中文沟通；`git commit` 用中文。

# 结构硬约束

- 插件必须是 `plugins/` 的**直接子目录**：`.opencode/plugins/opencode-providers/`
  （不可再嵌套；直接子 `.tsx` 文件不会被发现，只认 `.ts`/`.js`）
- 同目录**双入口**（`packages/plugin/src/host.ts:43` 的 `server: entry(["server",""])` / `tui: entry(["tui"])`）：
  - `index.ts` = **server 入口**：拉注册表 → 注册 integration / provider / models。**不得触碰 `context.ui`**
  - `tui.tsx` = **TUI 入口**：只注册 `/connect-providers` 命令与交互
- **server 入口不得 import 任何 `@opencode/*`（实测踩坑，opencode 2.0.24）**：脚本安装的本地 server 插件拿不到
  `@opencode/plugin`，会以 `ResolveMessage: Cannot find package '@opencode/plugin'` 加载失败（`/api/plugin` 里 `status: failed`）。
  `@opencode/plugin/tui` **是**注入的，TUI 入口照常 import。运行时需要的都是普通值：
  `Plugin.define` 是恒等函数（`export default { id, setup }`）、`Provider.ID.make`/`Integration.ID.make` 就是字符串、
  `Provider.Info.empty(id)` = `{ id, name: id, activation: "auto", package: "" }`。类型可用 `import type` 或本地结构化接口。
- 相对导入必须带显式扩展名（`./registry/schema.ts`）：server 插件由 bun 逐文件加载，TUI 侧同样；
  纯逻辑模块也要能被 `node --test` 原生 TS 解析
- `registry/` 与 `view/` 视为插件子模块，只被两个入口 import
- **故意没有根 `package.json`**：只走脚本安装，不发 npm，也不支持 `opencode.json` 的 `plugins` 配置安装
  （TUI 插件经配置安装会落进 `node_modules`，引入重复 Solid 运行时 → 只渲染首帧）

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

- **版本单一事实源 = `CHANGELOG.md`**（本仓**故意没有 `package.json`**）：`release.yml` 在 tag 触发时校验
  `tag == CHANGELOG 顶部版本小节`，不一致即 fail；Release 正文从该小节提取（不是 `git log` 堆砌）
- 流程：把 `CHANGELOG.md` 的 `[Unreleased]` 整理成 `## [x.y.z] - YYYY-MM-DD` → commit → `git tag vX.Y.Z` → `git push origin vX.Y.Z`
- `install.sh` / `install.ps1` 取源：最新 Release tag 优先，仓库无 Release 时回退 `main`
- `.github/workflows/ci.yml` 在 push main / PR 上跑 `node --test`

# 运行与验证

- 单测：`node --test`（Node ≥ 22 原生 TS strip，零依赖）
- 入口打包/语法检查（esbuild，`Done in` 即通过）：
  ```
  npx --yes esbuild .opencode/plugins/opencode-providers/index.ts --bundle --platform=node --format=esm \
    --outfile=dist/providers-server.js            # server 入口无外部依赖，不需要 --external
  npx --yes esbuild .opencode/plugins/opencode-providers/tui.tsx --bundle --platform=node --format=esm \
    --jsx=automatic --jsx-import-source=@opentui/solid \
    --external:@opencode/plugin/tui --external:@opentui/solid --external:solid-js --external:@opencode/client \
    --outfile=dist/providers-tui.js
  ```
- 安装后**通常无需重启**：覆盖插件目录里的文件会被文件监视热重载（实测 `/api/plugin` 立刻变为 `status=active`）；必要时再 `opencode service restart`
- 验证注册真的生效（实测可用的证据链）：
  ```
  opencode api get  /api/plugin       # 自己那条必须 state.status=active、features.server=true
  opencode api get  /api/integration  # methods 有 key、metadata.source=opencode-providers
  opencode api get  /api/model        # 只列可用 provider 的模型（无凭据时 0 条）
  opencode api get  /api/provider     # activation=auto / package / integrationID / settings.baseURL
  opencode api post /api/integration/<id>/connect/key --data '{"key":"sk-test"}'
  opencode api delete /api/credential/<cred_id>     # 验证完清理，别留假凭据
  ```
- 注册表没生效时先看 `/api/plugin` 的 `state.status`，再看 server 日志里的 `failed to load plugin ... cause=`
- **在仓库里跑 opencode 会加载两次**：全局安装（`~/.config/opencode/plugins/`）+ 项目内 `.opencode/plugins/` 是同一 id，
  按 boot 顺序**首见者生效**、后者按重复 id 上报失败；调试时只留一处可减少噪音
- **安装脚本已端到端实测**：`pwsh -NoProfile -File .\install.ps1` → 无 Release 时解析 `main` → clone → 原子替换 →
  插件被文件监视热重载为 `status=active`、集成仍在；安装后文件是 **CRLF**（`* text=auto` + 本机 `core.autocrlf=true`），
  **Bun 执行正常**（实测 active），只有 `*.sh` 被 `.gitattributes` 固定为 LF（因为要 `curl … | bash`）

# 文档索引（docs/）

- `opencode-commands.md` —— 内置命令 vs 插件命令、同名冲突语义、插件注册命令/对话框的可用 API
- `opencode-connect-custom-provider.md` —— `/connect` 数据来源、凭据存哪/如何注入、目录 TTL、自维护注册表怎么抄 models.dev
- `opencode-plugin-provider-no-config.md` —— 零 `opencode.json` 的证据链、`activation` 语义、模型参数来源与 TTL 参考
