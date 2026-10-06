# npm 分发与测试（参考 `opencode-goal` 后的结论）

> 参考对象：`E:\Code\Projects\Agent\opencode-goal`（v0.9.0，`@justsilver/opencode-goal-plugin`）。
> 它的 `docs/opencode/{releasing,config-install,plugin-dev-gotchas,smoke-checklist}.md` 与本仓的这份文档是同一路线，
> 下面的结论都标了「谁实测过」，不抄没验证的东西。

## 0. 一句话

本插件走 **npm 包 + 预发布优先**：`package.json` 是版本单一来源，先把 `0.1.0-beta.x` 发到 npm 的 **`next`** dist-tag 试装，
确认没问题再发正式版到 `latest`（正式版**必须手动确认**，流水线里拦着）。
同时保留脚本安装（把目录复制到 `~/.config/opencode/plugins/`）作为零依赖的备用路径。

## 1. 包形状（npm / 配置安装）

`package.json` 要点（本仓已按此配置）：

| 项 | 值 | 为什么 |
|---|---|---|
| `type` | `module` | 宿主按 ESM 加载 |
| `exports["./server"]` | `./plugin/opencode-providers/index.ts` | 包安装按 `exports` 解析 server 入口；缺它会**整包被 server 跳过**（无告警） |
| `exports["./tui"]` | `./plugin/opencode-providers/tui.ts` | 同上；且 `features.tui === true` 时宿主会自动加载 TUI 入口，不需要额外配置 |
| `files` | `plugin/**/*.ts`（排除测试）+ `CHANGELOG.md` | 白名单：`exports` 指向的文件必须在里面，否则打包后被剔掉 |
| `publishConfig.tag` | `next` | 让「忘记加 `--tag` 的 `npm publish`」也不会落到 `latest` |
| `main` | 同 server 入口 | 目录型/兜底解析用 |

两条入口解析路径**不同**（两边都要照顾，opencode-goal 实测）：

| 安装方式 | server 入口解析 |
|---|---|
| 目录（发现式 / `plugins: [{package: "<dir>"}]`） | `Host.resolve({directory})` → `<dir>/server.ts`，兜底 `<dir>/index.ts`（`main`/`exports` **不参与**） |
| 包（npm / git） | 包内 `exports["./server"]`（`main`/根 `server.ts` **不参与**） |

## 2. TUI 入口不要用 JSX（否则 npm/配置安装会踩「双 Solid」）

**现象**（opencode-goal 实测）：配置安装的 TUI 插件能画首帧，之后**永不刷新**（切一次会话才显示）。

**源码级根因**：TUI 运行时注册了 Solid 转换器与运行时重写器；重写器只能重写**源码文本里可见**的 import。
JSX 的 `import … from "@opentui/solid/jsx-runtime"` 是 Bun 转译时**注入**的，源码里不存在 → 不被重写 →
命中插件自己 `node_modules` 里的那份 Solid → 第二套响应式图。

**推论（也是本仓的做法）**：只要 TUI 入口**不写 JSX**，就不注入 `jsx-runtime`，npm / 配置安装照常工作。
本插件的 `/connect-providers` 只用 `ctx.ui.dialog.{select,prompt,alert}` 与 `ctx.ui.toast`（宿主渲染），
所以入口叫 `tui.ts`（**不是** `.tsx`），也不 import `solid-js` / `@opentui/*`，更不需要把它们声明成 `peerDependencies`
（声明了反而会被 npm 装一份副本进插件自己的 `node_modules`）。

## 3. 发布（预发布优先）

`.github/workflows/release.yml`：

| 触发 | 行为 |
|---|---|
| push tag `v*`（预发布版本号） | 校验版本一致 → 单测 → `npm publish --tag next` → 建/更新 GitHub Release |
| push tag `v*`（**正式**版本号） | **拦下**并报错：正式版只能手动发（防止误发 `latest`） |
| 手动 Run workflow（默认 `publish=false`） | 只做 `npm pack --dry-run` 打包预检，不发布 |
| 手动 Run workflow（`publish=true`） | 发当前 `package.json` 版本；正式版还需勾 `stable=true` 才发 `latest` |

硬性要求与踩坑（opencode-goal 实测 + 官方文档）：

- **`tag == package.json.version == CHANGELOG 顶部版本` 三处一致**，由 `scripts/changelog.mjs check` 在 CI 与 CD 里强制；不一致**不产生任何发布动作**。
- **预检要用 `npm pack --dry-run`，不要用 `npm publish --dry-run`**：后者仍会向 registry 校验「版本是否已存在」，当前版本已发布时直接报
  `You cannot publish over the previously published versions`。
- **已发布过的版本号永不复用**；流水线里对「registry 上已存在该版本」做幂等跳过；真要回滚就发 patch。
- 默认走 **npm Trusted Publishing（OIDC）**：`permissions: id-token: write`，**不需要** `NPM_TOKEN`，也不要写
  `publishConfig.provenance`（会让本地人工发布失败）。前提是 npm 侧登记过 trust 关系，**且包必须已经存在**
  → 因此 `0.1.0-beta.0` 这一步需要**人工首发一次**（`npm login` + `npm publish --tag next`），之后才交给 CD。
- trust 关系里的 **Workflow filename 必须与 `release.yml` 同名**（改名要同步改 npm 侧），`Environment` 留空要两边一致。

## 4. 测试

| 层 | 手段 | 覆盖什么 |
|---|---|---|
| 单测 | `node --test`（本仓 31 条，零依赖） | 注册表 schema、模型映射、拉取缓存/陈旧回退、版本一致性工具 |
| CI | `.github/workflows/ci.yml` | 版本一致性 + 单测 |
| 真机冒烟（HTTP） | `node scripts/smoke-api.mjs`（本仓） | 插件已加载（`/api/plugin`）、供应商已注册（`/api/integration`）、凭据→模型→清理（`/api/model`） |
| 真机手测 | 在 TUI 里敲 `/connect-providers` | 命令面交互（选供应商 / 贴 key / 切账号）——**脚本覆盖不到**，只能人看 |

`scripts/smoke-api.mjs` 的要点（照搬 opencode-goal 的姿势）：

- **鉴权自动读** `~/.local/state/opencode/service.json` 的 `url`/`password`（Basic `opencode:<password>`）；
  `opencode pair` 现在只给一次性连接链接、**不再打印口令**。
- **会真的动状态**：`models` 场景写入一条临时凭据（label `smoke-throwaway`）再删除；只对「当前没有任何凭据」的 supplier 生效。
- 断言「无凭据时不在 `/api/model`、有凭据时出现、清理后回到 0」——这正是本插件 `activation: "auto"` 的设计承诺。
- 与之相对，opencode-goal 的脚本还要读宿主 KV；读 `opencode.db` **必须把 `-wal`/`-shm` 一起复制**，否则只读连接看不到新写入。

### 判定「插件到底加载没加载」

- `opencode plugin list` / `/api/plugin` **不能**作为单次热重载的判据（它读后台 service 的缓存）；
  真值看日志：`opencode api --standalone get /api/plugin --print-logs`，找
  `msg="loading plugin" entrypoint=…` 与 `WARN failed to load plugin … cause=`。
- 同一个插件 id 被发现两次时，supervisor **保留首个**、把后来者塞进 `failures`：
  `/api/plugin` 里就是一条 `state.status="failed"`、`error="Duplicate plugin ID: <id>"`
  （`packages/core/src/plugin/supervisor.ts:96-111`）。面板上的红行多半是这个，而不是真加载失败。
- `@opencode/plugin`（server 入口）**不会被注入**，`@opencode/plugin/tui`（TUI 入口）**会**；
  所以 server 入口不能 import 任何 `@opencode/*`。

### npm 渠道本身的验证（上游限制）

`opencode plugin add <spec>` 可用（opencode-goal 已验证从 registry 解析并安装）；
但 `plugin check` / `plugin update` 的端到端验证在**共享 host server** 的机器上做不了
（CLI 复用已在跑的 server，读真实全局配置，临时 `OPENCODE_CONFIG_HOME` / 隔离 HOME 都不生效）——
要在**独立 HOME + 没有在跑的 server** 的干净环境里补测。这条与本插件无关（是宿主行为）。

## 5. 首版发布：必须人工一次（本仓实测）

**结论：npm 的 trusted publisher 关系挂在「已存在的包」上，所以第一个版本只能人工发一次。**

本仓实测证据（GitHub Actions run `37545609151`，`workflow_dispatch` + `publish=true`）：

```
npm notice Publishing to https://registry.npmjs.org/ with tag next and public access
npm error code E404
npm error 404 Not Found - PUT https://registry.npmjs.org/@justsilver%2fopencode-providers
npm error 404  The requested resource '@justsilver/opencode-providers@0.1.0-beta.0' could not be found
               or you do not have permission to access it.
```

即 **OIDC 无法创建包**。同一台机器上走 token 的 `npm publish` 也发布不了：

```
npm error code EOTP
npm error This operation requires a one-time password.
npm error Open this URL in your browser to authenticate:  https://www.npmjs.com/auth/cli/***
```

- 该账号是 `auth-and-writes` 2FA：写入必须过浏览器授权；而**非交互 shell（agent 常用）拿到的 EOTP 链接被 `***` 打码**，没法转交给别人点。
- npm 正在收紧「bypass 2FA 的 token 直接发布」（见 `https://gh.io/npm-gat-bypass2fa-deprecation`），别再指望长期 token。
- 结论：**首版必须在自己的交互式终端里发**（浏览器点一下授权）；之后 CD 全自动。

### 人工首发 runbook

```bash
cd <仓库根>
node scripts/changelog.mjs check --tag v0.1.0-beta.0   # tag / package.json / CHANGELOG 三处一致
npm whoami                                            # 应为 justsilver
npm publish --tag next                                # 预发布 → next（不是 latest）
```

- 若提示 `EOTP` + 链接：浏览器打开并授权后**重跑**该命令；也可 `npm publish --tag next --otp=<6 位验证码>`。
- 成功后核对（`latest` 应**不存在**）：
  ```bash
  npm view @justsilver/opencode-providers dist-tags    # { next: '0.1.0-beta.0' }
  npm view @justsilver/opencode-providers versions
  ```

### 紧接着必须确认的两件事（否则 CD 仍可能发不出去）

1. **trust 配置要显式允许 `npm publish`**：2026-09-03 之后新建的 trusted publisher **默认只允许 `npm stage publish`**（暂存发布、需人工批准）。
   到 npm → 该包 → Settings → **Trusted publishing**：仓库 `Just-Silver/opencode-providers`、Workflow filename 必须正好是 `release.yml`（含 `.yml`）、
   Environment 留空，并勾上允许 **`npm publish`**。npm 保存时**不校验**这些字段，写错只会在发布瞬间报错。
2. **新 trust 配置 2 天有效期**：npm 文档写明「新建的 trusted publisher 配置必须**在 2 天内完成首次成功发布**来绑定仓库身份，否则过期且不可编辑（只能删掉重建）」。
   所以包一存在就尽快跑一次 CD 发布，别拖。

### 之后（全自动）

```bash
# 打测试版：bump 预发布号 → 提交 → push tag → CD 自动发到 next
npm version prerelease --preid beta --no-git-tag-version
git commit -am "chore(release): v0.1.0-beta.1" && git tag v0.1.0-beta.1 && git push origin main v0.1.0-beta.1

# 或不起 tag，直接手动触发（同样只发 next、不碰 latest）
gh workflow run release.yml -f publish=true
```

正式版：手动 Run workflow 且勾 `publish` + `stable`（push 一个正式 tag 会被流水线拦下）。
