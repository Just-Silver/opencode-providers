# 贡献指南

> **职责**（贡献者）：本地开发 / 架构 / 测试 / 注册表维护 / 发版。使用者文档见 [README.md](./README.md)。

`opencode-providers` 欢迎贡献。本文面向**开发者**：改插件代码、维护注册表数据、发版。

## 可以怎么贡献

- **修 bug / 加功能**：改 `plugin/opencode-providers/**`，并在 `tests/**` 补用例。
- **维护注册表数据**：在 `registry/**` 新增/修改供应商与模型（走技能 CLI，别手改 JSON）。
- **完善文档**：README / CONTRIBUTING / `docs/**`。

## 环境与依赖

- **Node ≥ 24**（CI 用 24）。`node --test` 直接跑 `.ts`，依赖 Node ≥ 23.6 的默认类型擦除。
- **零运行时依赖**；`devDependencies` 只有 `@opencode/plugin`（仅供类型）。
- 本仓**没有 lint / typecheck / formatter**：改完自己跑单测（见「测试」）。

## 项目结构

```
registry/                              ← 自维护注册表（GitHub raw 直供，插件运行期拉取并聚合）
  index.json                           ← manifest：schemaVersion / revision / providers[]（CLI 自动维护）
  providers/<id>/provider.json         ← 该家供应商参数
  providers/<id>/models.json           ← 该家模型（key = 模型 ID）
  models/<lab>/<model>.json            ← 顶层共享模型（多家用 base 引用）
plugin/opencode-providers/             ← 插件源码（npm 包的 server / tui 入口所在）
  index.ts                             ← server 入口：拉注册表 → 注册 integration/provider/models
  tui.ts                               ← TUI 入口：注册 /connect-providers 命令（不写 JSX）
  rpc.ts                               ← 强制刷新 RPC 定义（纯 JSON Schema）
  registry/                            ← 纯逻辑：schema 校验 / 分文件聚合 / 拉取缓存
  view/                                ← /connect-providers 交互
.opencode/skills/opencode-providers-registry/   ← 维护注册表的技能与 CLI
scripts/                               ← changelog.mjs（版本/发布说明）、smoke-api.mjs（真机冒烟）
tests/                                 ← node --test 用例
docs/                                  ← 深度参考（见「文档地图」）
```

> 源码**故意不放在 `.opencode/plugins/` 下**：那是 opencode 的自动发现根，放在那里会让「在本仓库里跑 opencode」
> 与 npm 那份**同 id 相撞**，supervisor 保留首个、把后来者标成 `failed`（`Duplicate plugin ID: opencode-providers`），
> `/plugins` 面板出现一条误导性的红行。同理，`registry/` 与 `view/` 视为插件子模块，只被两个入口 import。

## 本地开发（直接跑工作树）

不想先发版也能让 opencode 加载**当前工作树**：在 `opencode.json(c)` 的 `plugins` 里给一个**绝对路径目录**
（opencode 按「本地目录插件」处理，该目录需含 `index.ts` 与 `tui.ts`）：

```jsonc
{
  "plugins": [
    { "package": "<绝对路径>/opencode-providers/plugin/opencode-providers" }
  ]
}
```

- 改完源码会被文件监视**热重载**，无需发布、也无需 `npm install`；必要时 `opencode service restart`。
- 它和 npm 包**同 id**，别同时留着两条，否则 `/plugins` 面板会出现一条 `failed`。

## 架构与硬约束

完整约束清单见 [AGENTS.md](./AGENTS.md)；设计背景与证据链见 `docs/`。要点：

- **同目录双入口**：`index.ts`（server，拉注册表并注册）与 `tui.ts`（只注册 `/connect-providers`，**不读注册表**）。
- **server 入口不得 import 任何 `@opencode/*`**（实测会 `Cannot find package '@opencode/plugin'` 而加载失败）；
  `@opencode/plugin/tui` **是**注入的，TUI 入口照常 import。运行时需要的都是普通值
  （`Plugin.define` 是恒等函数、`Provider.ID.make` 就是字符串）。
- **相对导入必须带显式扩展名**（`./registry/schema.ts`）。
- **TUI 入口不写 JSX**（文件名是 `tui.ts` 不是 `.tsx`）：否则配置安装会命中插件自带的 Solid 副本，
  变成**第二套响应式图**（现象：只渲染首帧、之后永不刷新）。
- 注册/激活：注册表每家都注册 + `activation: "auto"` + integration 只声明 `key`；
  凭据存在 opencode 自己的 SQLite，靠 `provider.integrationID === integration.id` 注入。
- 改注册表**不需要**发插件版本（`schemaVersion` 解耦）。

## 测试

```bash
node --test                                                                      # 全量单测（零依赖）
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs validate  # 分文件注册表：组装 + schema + index/revision 一致
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs check --strict
node scripts/smoke-api.mjs --list                                                # 真机冒烟场景（HTTP，不需要 TUI）
node scripts/smoke-api.mjs                                                       # 全跑：插件已加载 / 供应商已注册 / 凭据→模型→清理
```

- `smoke-api.mjs` 的鉴权自动读 `~/.local/state/opencode/service.json`；它的 `models` 场景会写入并删除一条
  临时凭据（label `smoke-throwaway`），且只对「当前没有任何凭据」的供应商生效。

入口打包 / 语法检查（`Done in` 即通过）。server 入口无外部依赖；TUI 入口的 `@opencode/plugin/tui` 是运行时注入的，
**必须**标 `--external`，否则 esbuild 解析失败（实测 exit 1）：

```bash
npx --yes esbuild plugin/opencode-providers/index.ts --bundle --platform=node --format=esm \
  --outfile=dist/providers-server.js

npx --yes esbuild plugin/opencode-providers/tui.ts --bundle --platform=node --format=esm \
  --external:@opencode/plugin/tui --outfile=dist/providers-tui.js
```

npm 打包预检（不发布）：`npm pack --dry-run`（确认 `plugin/**/*.ts` + CHANGELOG 进了 tarball）。

## 验证注册真的生效

用 opencode 自己的 API（不需要看 TUI）：

```bash
opencode api get  /api/plugin       # 自己那条必须 state.status=active、features.server/tui=true；多于 1 条 = 同 id 被发现两次
opencode api get  /api/integration  # methods 有 key、metadata.source=opencode-providers
opencode api get  /api/model        # 只列可用 provider 的模型（无凭据时 0 条）
opencode api get  /api/provider     # activation=auto / package / integrationID / settings.baseURL
opencode api post /api/integration/<id>/connect/key --data '{"key":"sk-test"}'
opencode api delete /api/credential/<cred_id>     # 验证完清理，别留假凭据
```

判定「插件到底加载没加载」：

- `opencode plugin list` / `/api/plugin` **不能**作为单次热重载的判据（它读后台 service 的缓存）；
  真值看日志：`opencode api --standalone get /api/plugin --print-logs`，找 `msg="loading plugin" entrypoint=…`
  与 `WARN failed to load plugin … cause=`。
- **同一插件 id 被发现两次** → supervisor 保留首个，把后来者标 `failed` + `Duplicate plugin ID: <id>`；
  面板上的红行多半是这个，而不是真加载失败。
- 插件里的 `console.*` **不会**进 `~/.local/share/opencode/log/opencode.log`（实测）；要复现「拉取 + 解析」是否正常，
  直接 `node -e` 调 `loadRegistry`（`registry/source.ts` 是注入式设计）。
- 注册表没生效时，先看 `/api/plugin` 的 `state.status`，再看 server 日志里的 `failed to load plugin ... cause=`。
- 查注册表缓存（只读，最安全）：

  ```bash
  node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.USERPROFILE+'\\.local\\share\\opencode\\opencode.db',{readOnly:true});const ns='plugin:'+[...'opencode-providers'].map(c=>c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+':';for(const r of db.prepare('SELECT key,value FROM kv WHERE key LIKE ?').all(ns+'%')){const v=JSON.parse(r.value);console.log(r.key.slice(ns.length),'|',new Date(v.fetchedAt).toISOString(),'|',v.etag)}"
  ```

换注册表 URL / 删注册表条目后要**触发一次重载**才生效（改文件、重装、重启）；URL 404 时插件沿用旧缓存，
但**新 key 无缓存时 setup 会直接 return**（插件 active 却注册 0 条）。

### 坑：注册表 id 与 `opencode.json` 里 `providers.<id>` 撞名「各管一半」

同一个 id 两边都声明时：integration 的 `metadata.source`/`keyLabel`/`methods` 用**注册表**那份，
但 provider 的 `activation` 与 `settings.apiKey` 仍是**配置**那份（`enabled` + 明文 env key）
⇒ 模型无凭据也可见、`auto` 语义失效。要完全走注册表就删掉配置里那一块；只想用 `{env:…}` 就别写进注册表 ——
**同 id 两边只留一边**。

> 安全提醒：把 `settings.apiKey` 写成 `{env:VAR}` 时，opencode 会把它**解析成明文**放进 provider settings
> （`/api/provider` 里肉眼可见）。带 key 的 provider 不要留在 `opencode.json` 里给工具去读。
> 迁移注意：配置里的 `{env:…}` key **不会**自动搬进 opencode 的凭据表，删掉配置块后要重新粘一次。

## 维护注册表

源在 `registry/`（`index.json` manifest + `providers/**` + `models/**`）。改完提交后，**下一次插件被加载**时才会跟上：
加载时若缓存已超过 6 小时（TTL）就重新拉取。插件**没有后台定时器**，所以一个连着跑很久的服务不会自己刷新 ——
想立刻生效就在 `/connect-providers` 弹窗里按 `Ctrl+R`（Force refresh），或 `opencode service restart`。
拉取先抓 manifest（`ETag`）；`revision` 与缓存一致就不重拉子文件，变了才并发拉各分文件并重新聚合；
网络失败时继续沿用本地缓存，不会把供应商列表清空。

> **别手改 `registry/**` 的 JSON**：走技能 CLI（见下），它会组装 + 过 `parseRegistry` 校验后再落盘，
> 并自动重算 `index.json` 的 `providers`/`revision`；冲突（重复供应商 id / 重复模型 key / 占用 baseURL / 悬空 `base`）
> 直接报错、不写文件。

### 结构

按供应商拆分（`registry/index.json` 是 manifest，其 `revision` 与 `providers` 由维护脚本自动维护）：

```
registry/
  index.json                       # manifest：{ schemaVersion, revision, providers: ["my-gateway", …] }
  providers/my-gateway/
    provider.json                  # 供应商参数
    models.json                    # 该家模型（key = 模型 ID）
  models/some-lab/some-model.json  # 顶层共享模型（可选；多家用 base 引用）
```

`providers/<id>/provider.json`：

```jsonc
{
  "name": "My Gateway",
  "package": "@opencode/ai/providers/openai-compatible",
  "baseURL": "https://llm.example.com/v1"
}
```

`providers/<id>/models.json`（key = 在 opencode 里使用的模型 ID；`base` 指向共享模型；`modelID` 是发给上游的真实 ID）：

```jsonc
{
  "some-model": { "base": "some-lab/some-model", "name": "Some Model", "limit": { "context": 131072, "output": 16384 } },
  "some-model-fast": { "base": "some-lab/some-model", "modelID": "some-model-2026-01" }
}
```

`registry/models/<lab>/<model>.json`（顶层共享模型，供应商无关）：

```jsonc
{
  "name": "Some Model",
  "family": "some-lab",
  "limit": { "context": 131072, "output": 16384 },
  "cost": { "input": 0.5, "output": 1.5, "cache_read": 0.05 },
  "tools": true,
  "input": ["text", "image"],
  "output": ["text"]
}
```

### 字段

| 字段 | 说明 |
|---|---|
| manifest `schemaVersion` | 当前为 `1`；插件只接受自己支持的版本，不匹配就整份拒绝（不会半注册） |
| manifest `revision` | `providers/**` + `models/**` 全部文件内容的确定性哈希；子文件改动会连带它一起变，插件据此决定是否重拉 |
| `provider.json` `package` | 运行时包，如 `@opencode/ai/providers/openai-compatible`（**不要**用旧的 `aisdk:` / `@ai-sdk/*` 写法） |
| `provider.json` `baseURL` | API 端点；与 `settings` 合并后作为 provider `settings` |
| `provider.json` `keyLabel` | `/connect-providers` 里 API Key 输入框的提示，默认 `Paste API key`（技能 CLI 保持最小字段，不写它） |
| `models.json` 的 key | 模型 ID（`provider/model` 里的 model 段）；各项字段见下方 `模型 …` 各行 |
| 模型 `base` | 引用顶层共享模型（值形如 `<lab>/<model>`，对应 `registry/models/<lab>/<model>.json`），先铺共享参数再用本项覆盖 |
| 模型 `modelID` | 发给上游的真实模型/部署 ID，默认等于上面的 key |
| 模型 `limit` | `context` / `output` 必填（无 `base` 时），`input` 可选 |
| 模型 `cost` | 每百万 token 美元；`cache_read`/`cache_write` 可选 |
| 模型 `tools` / `input` / `output` | 能力：是否支持工具调用、输入/输出模态，默认 `true` / `["text"]`；**`input` 要多模态必须显式写** |
| 模型 `reasoningField` / `maxTokensField` | 映射到 `Model.Compatibility` |
| 模型 `variants` | `[{ "id": "high", "settings": {} }]` |
| 模型 `status` / `disabled` | 生命周期标记；`disabled: true` 不出现在 `/models` |

字段的权威校验是插件里的 `parseRegistry`；维护时用技能 CLI 的 `validate`（组装 → schema → `index.json`/目录/`revision`
一致性）即可，本仓不随仓放 JSON Schema 文件。

### 技能 CLI

`.opencode/skills/opencode-providers-registry/`（其 `SKILL.md` 是给 agent 的路由说明）：

```bash
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs list
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs search <关键词>
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs show <id>
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs add-provider ...
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs add-model ...
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs add-shared-model ...
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs set-provider|set-model|set-shared-model ...
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs remove-provider|remove-model|remove-shared-model ...
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs sync
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs validate
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs check [--strict]
```

- **新增模型前先 `search`**：命中已有的顶层共享模型就用 `add-*/--base <lab>/<model>` **复用**（不必逐项重写 limit/变体/模态）。
- `check [--strict]` 做更全体检：悬空 `base` 引用 / 孤儿共享模型 / 重复 baseURL / `input` 缺 text / 空目录。
- 写命令结束会**自动重算并重写** `index.json`；手改了子文件就用 `sync` 补齐，再 `validate`。
- `revision` = `providers/**` + `models/**` 全部文件按 posix 相对路径排序后的确定性哈希。

> **红线（给 agent）**：禁止直接读整份注册表（会随规模变大），查/改全走 CLI。完整路由
> （新增供应商 / 给已有供应商加模型 / 复用共享模型，及一次性 `question` 模板）见
> `.opencode/skills/opencode-providers-registry/SKILL.md`。

## 发版

- **版本单一事实源 = `package.json` 的 `version`**：CI/CD 用 `node scripts/changelog.mjs check [--tag vX.Y.Z]` 校验
  `tag == package.json == CHANGELOG 顶部版本小节` 三处一致，不一致**不产生任何发布动作**；
  Release 正文用 `node scripts/changelog.mjs notes --out …` 从 CHANGELOG 该小节截取（不是 `git log` 堆砌）。
- **预发布优先**：先发 `x.y.z-beta.n` 到 npm 的 **`next`**（`publishConfig.tag = next`），验证后再发正式版到 `latest`。
- **流程**：整理 `CHANGELOG.md` 的 `[Unreleased]` 成 `## [x.y.z(-beta.n)] - YYYY-MM-DD`
  → `npm version <ver> --no-git-tag-version`（只改 `package.json`）→ commit
  → 预发布 push tag `vX.Y.Z-beta.n`（或 Actions → Release → Run workflow 勾 `publish`）。
- **正式版只能手动**：`npm version x.y.z --no-git-tag-version` → commit → `git push origin main`，然后
  **Actions → Release → Run workflow 勾 `publish` + `stable`**（会发 `latest` + 补建 tag `vX.Y.Z` + 建 Release）。
  **不要**直接 push 正式 tag：那会被流水线拦下（这正是防止误发正式版的闸门）。
- **认证走 npm Trusted Publishing（OIDC，`id-token: write`，无长期 token）**：但**包必须已存在**，
  所以**首个版本要人工在自己的交互式终端发一次**（`npm login` + `npm publish --tag next`）——npm 侧的 trust 关系
  挂在已存在的包上，且新建 trust 配置有 2 天有效期。完整 runbook 与核对项见 `docs/npm-distribution-and-testing.md` §5。
- 预检用 `npm pack --dry-run`，**别用 `npm publish --dry-run`**（后者会因「版本已存在」而报错，哪怕只是想预检）。
- **发布后 tarball 有传播延迟**：packument（版本/dist-tag）已可见，但 tarball URL 仍 404，
  `opencode plugin update` 会报 `404 ...tgz`；等几分钟重试即可（不是发布失败）。
- `.github/workflows/ci.yml` 在 push main / PR 上跑「版本一致性 + `node --test` + 注册表 validate/check」；
  **没有 lint/typecheck/formatter**。

## 约定

- 提交信息用**中文**；每个 commit 前 `node --test` 全绿。
- 相对导入带显式扩展名；**不留死代码**（声明了却没人用的 export / 可达不到的钩子都算）。
- 临时文件/探针用完清理，别留在用户机器上（探针注册表还要删掉它留下的 `kv` 缓存行）。

## 文档地图

本仓各文档的职责（哪份负责什么 / 不写什么）见 [AGENTS.md 的「文档地图」](./AGENTS.md#文档地图)——唯一索引，此处不重复。
