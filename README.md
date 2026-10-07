# opencode-providers

给 [OpenCode](https://opencode.ai) 补上**模型目录里没有的供应商**：一份自维护的注册表 + 一个插件。
装完插件、在 `/connect-providers` 里贴一次 API Key 就能用 —— **不需要写 `opencode.json`**。

```
registry/index.json              ← manifest：schemaVersion / revision / providers[]（CLI 自动维护）
registry/providers/<id>/          ← 每家：provider.json（供应商参数）+ models.json（该家模型）
registry/models/<lab>/<model>.json ← 顶层共享模型（多家用 base 引用）
plugin/opencode-providers/       ← 插件源码（安装时整目录复制到 ~/.config/opencode/plugins/）
├── index.ts                     ← server 入口：拉注册表 → 注册 integration/provider/models
├── tui.ts                       ← TUI 入口：注册 /connect-providers 命令（不写 JSX，见下）
├── registry/                    ← 纯逻辑：schema 校验 / 元数据映射 / 拉取缓存
└── view/                        ← /connect-providers 交互
```

> 源码**故意不放在 `.opencode/plugins/` 下**：那样在本仓库里跑 opencode 时，仓库副本会和全局安装副本撞同一个插件 id，
> 被 supervisor 判为 `Duplicate plugin ID: opencode-providers`，在 `/plugins` 面板里显示成一条 `failed`（实际加载的是另一条，功能正常）。

## 为什么需要它

OpenCode 的供应商清单来自 models.dev 目录，**目录里没有的供应商不会出现在 `/connect`**。
想用自建/网关/小众供应商，原本只能在 `opencode.json` 里手写 `providers.<id>` 加一长串模型参数。
本项目把这份数据搬到一份共享注册表里，由插件在运行期注册 —— 配置零增长，改注册表也不用改插件版本。

## 安装

### 方式 A：npm 包（推荐）

在 `opencode.json(c)` 里写一行（不需要手写 provider/模型）：

```jsonc
{
  "plugins": ["@justsilver/opencode-providers"]
}
```

等价的一条命令（帮你写进全局配置）：`opencode plugin add @justsilver/opencode-providers`。

想**试某个测试版**就把版本写全（试完再回到正式版）：

```jsonc
{
  "plugins": ["@justsilver/opencode-providers@0.1.0-beta.2"]
}
```

- 预发布版本发布在 npm 的 **`next`** dist-tag 上，正式版才发 `latest`。
- 升级 / 卸载（`<目标>` 就是配置里那串原样）：`opencode plugin update @justsilver/opencode-providers` / `opencode plugin remove …`。
- 本插件的 TUI 入口**不含 JSX**、不依赖 Solid，所以配置安装不会踩「双 Solid 运行时」的坑。
- 想指向**别的注册表**（自建/私有）：配置改成对象条目传 options，不用改源码——

  ```jsonc
  {
    "plugins": [
      { "package": "@justsilver/opencode-providers", "options": { "registryUrl": "https://example.com/registry/index.json" } }
    ]
  }
  ```

### 方式 B：安装脚本（零依赖备用路径）

```bash
# Linux / macOS
./install.sh
```

```powershell
# Windows
.\install.ps1
```

脚本把 `plugin/opencode-providers/` 整目录装到：

```
~/.config/opencode/plugins/opencode-providers/        # $XDG_CONFIG_HOME 优先
```

装完**通常无需重启**（插件目录被文件监视，覆盖后自动热重载）；必要时 `opencode service restart`。
卸载：`./uninstall.sh` / `.\uninstall.ps1`。

开发时把**工作树**（含未提交改动）直接部署到全局插件目录：

```bash
bash install.sh --local
```
```powershell
pwsh -NoProfile -File .\install.ps1 -Local
```

## 使用

```
/connect-providers        # 选供应商 → 贴 API Key
/models                   # 该供应商的模型随即出现在列表里
```

- 触发方式与内置 `/connect` 相同：**在输入框敲 `/`，在补全菜单里选中它**（选中即执行）；
  也可以在命令面板里搜 `Connect providers`（该命令注册了 `palette: true`）。
  手打全名再回车**不会**触发（与 `/connect` 一致），因为无参数命令只走补全菜单。

再运行一次可以添加第二个账号，或在已有账号之间切换。

在 `/connect-providers` 弹窗里按 `Ctrl+R`，或点弹窗底部那行 **Force refresh**，
即可绕过 6h TTL 立刻重拉注册表并重注册（上游拉不到时保留原有列表并报错，不会清空）。

**为什么 `/models` 里一开始看不到新供应商**：provider 声明为 `activation: "auto"`，
只有拿到凭据（你在 `/connect-providers` 里存过 key）后才会出现在 `/models`。
这样就算注册表里有几十家供应商，也只会显示你真正配了 key 的那些。

凭据存在 opencode 自己的 SQLite 里（`opencode debug paths db`），和内置 `/connect` 完全一致。
API Key 只在你贴入时经过本插件的内存，不落任何本项目自己的文件。

## 维护注册表

改注册表源（`registry/index.json` / `registry/providers/**` / `registry/models/**`）提交后，**下一次这个插件被加载时**才会跟上：加载时若缓存已超过 6 小时（TTL）就重新拉取。
插件**没有后台定时器**，所以一个连着跑很久的服务不会自己刷新——想立刻生效就在 `/connect-providers` 弹窗里按 `Ctrl+R`（强制刷新），或 `opencode service restart`。
拉取先抓 manifest（`ETag`）；`revision` 与缓存一致就不重拉子文件，变了才并发拉各分文件并重新聚合；网络失败时继续沿用本地缓存，不会把供应商列表清空。

### 结构

源按供应商拆分（`registry/index.json` 是 manifest，其 `revision` 与 `providers` 由维护脚本自动维护）：

```
registry/
  index.json                       # manifest：{ schemaVersion, revision, providers: ["my-gateway", …] }
  providers/my-gateway/
    provider.json                  # 供应商参数
    models.json                    # 该家模型（key = 模型 ID）
  models/some-lab/some-model.json    # 顶层共享模型（可选；多家用 base 引用）
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

| 字段 | 说明 |
|---|---|
| manifest `schemaVersion` | 当前为 `1`；插件只接受自己支持的版本，不匹配就整份拒绝（不会半注册） |
| manifest `revision` | `providers/**` + `models/**` 全部文件内容的确定性哈希；子文件改动会连带它一起变，插件据此决定是否重拉 |
| `provider.json` `package` | 运行时包，如 `@opencode/ai/providers/openai-compatible`（**不要**用旧的 `aisdk:` / `@ai-sdk/*` 写法） |
| `provider.json` `baseURL` | API 端点；与 `settings` 合并后作为 provider `settings` |
| `provider.json` `keyLabel` | `/connect-providers` 里 API Key 输入框的提示，默认 `Paste API key`（技能 CLI 保持最小字段，不写它） |
| `models.json` 的 key | 模型 ID（`provider/model` 里的 model 段）；每项字段见下表 |
| 模型 `base` | 引用顶层共享模型（值形如 `<lab>/<model>`，对应 `registry/models/<lab>/<model>.json`），先铺共享参数再用本项覆盖 |
| 模型 `modelID` | 发给上游的真实模型/部署 ID，默认等于上面的 key |
| 模型 `limit` | `context` / `output` 必填（无 `base` 时），`input` 可选 |
| 模型 `cost` | 每百万 token 美元；`cache_read`/`cache_write` 可选 |
| 模型 `tools` / `input` / `output` | 能力：是否支持工具调用、输入/输出模态，默认 `true` / `["text"]`；**`input` 要多模态必须显式写**（技能会用多选问你） |
| 模型 `reasoningField` / `maxTokensField` | 映射到 `Model.Compatibility` |
| 模型 `variants` | `[{ "id": "high", "settings": {} }]` |
| 模型 `status` / `disabled` | 生命周期标记；`disabled: true` 不出现在 `/models` |

字段的权威校验是插件里的 `parseRegistry`；维护时用技能 CLI 的 `validate`（组装 → schema → `index.json`/目录/`revision` 一致性）即可，不再随仓放 JSON Schema 文件。

## 范围之外

- **不做参数推断**：注册表写什么就是什么，插件不会去猜 `limit`/`cost`。
- **不调供应商 API**：不访问 `/v1/models`，也就没有运行期的额外网络与失败面。
- **不声明 `env` 认证**：本插件只走 `/connect`-式交互；opencode 的 env 是静默旁路且不在 `/connect` 里展示。
- 账号重命名/删除请用内置 `/connect`（同一个 integration，同一个凭据表）。

## 开发

```bash
node --test                        # 纯逻辑单测（Node ≥ 24 原生 TS，无需依赖）
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs validate   # 分文件注册表：组装 + schema + index/revision 一致
node scripts/smoke-api.mjs --list  # 真机冒烟场景（HTTP，不需要 TUI）
node scripts/smoke-api.mjs         # 全跑：插件已加载 / 供应商已注册 / 凭据→模型→清理
```

`smoke-api.mjs` 的鉴权自动读 `~/.local/state/opencode/service.json`；它的 `models` 场景会写入并删除一条
临时凭据（label `smoke-throwaway`），且只对「当前没有任何凭据」的供应商生效。

两个入口的打包/语法检查（TUI 入口的 `@opencode/plugin/tui` 是运行时注入的，必须标 `--external`）：

```bash
npx --yes esbuild plugin/opencode-providers/index.ts --bundle --platform=node --format=esm \
  --outfile=dist/providers-server.js

npx --yes esbuild plugin/opencode-providers/tui.ts --bundle --platform=node --format=esm \
  --external:@opencode/plugin/tui --outfile=dist/providers-tui.js
```

改完插件文件**通常无需重启**：插件目录被文件监视，覆盖后自动热重载。
验证是否真的注册成功（用 opencode 自己的 API，不需要看 TUI）：

```bash
opencode api get /api/plugin        # 自己那条 state.status 必须是 active（多于 1 条 = 同 id 被发现两次）
opencode api get /api/integration   # 注册的供应商（metadata.source = opencode-providers）
opencode api get /api/model         # 只列可用供应商的模型；没配 key 时不会出现
```

**发布策略（预发布优先）**：`package.json` 的 `version` 是版本单一来源；
预发布（如 `0.1.0-beta.0`）发到 npm 的 **`next`** dist-tag，正式版必须手动确认才发 `latest`。
流水线：整理 `CHANGELOG.md` 的版本小节 → `npm version <x.y.z[-beta.n]> --no-git-tag-version` → commit →
push tag `vX.Y.Z-beta.n`（或 Actions → Release → Run workflow 勾 `publish`；不勾只做 `npm pack --dry-run` 预检）。
**首个版本必须人工发一次**（OIDC/trusted publisher 挂不到尚不存在的包上），命令与核对项见
`docs/npm-distribution-and-testing.md` §5。

## 疑难解答

| 现象 | 原因 / 处理 |
|---|---|
| `/plugins` 面板里本插件有**一条 `failed`** | 同一插件 id 被发现两次（例：脚本装到 `~/.config/opencode/plugins/` + 又在 `opencode.json` 里配了 npm 包，或某个项目的 `.opencode/plugins/` 里也有一份）。supervisor 保留首个、把后来者标成 `failed`，错误信息是 `Duplicate plugin ID: opencode-providers`。删掉多余的那份即可 |
| `/connect-providers` 说没有可用供应商 | 注册表没加载成功。看 server 日志里的 `[opencode-providers]`，并确认 `/api/plugin` 里自己那条 `state.status` 是 `active` |
| `/models` 里看不到新供应商 | 正常：`activation: "auto"`，在 `/connect-providers` 里存过 key 之后才会出现 |
| 改了插件代码没生效 | 覆盖的是**全局**那份（`~/.config/opencode/plugins/opencode-providers/`）。开发时用 `install.ps1 -Local` / `install.sh --local` 把工作树复制过去 |

验证命令见上面的「开发」小节。
