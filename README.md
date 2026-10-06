# opencode-providers

给 [OpenCode](https://opencode.ai) 补上**模型目录里没有的供应商**：一份自维护的注册表 + 一个插件。
装完插件、在 `/connect-providers` 里贴一次 API Key 就能用 —— **不需要写 `opencode.json`**。

```
registry.json                    ← 唯一事实源：供应商 + 模型 + 参数（GitHub raw 托管）
registry.schema.json             ← 给编辑器校验 registry.json
.opencode/plugins/opencode-providers/
├── index.ts                     ← server 入口：拉注册表 → 注册 integration/provider/models
├── tui.tsx                      ← TUI 入口：注册 /connect-providers 命令
├── registry/                    ← 纯逻辑：schema 校验 / 元数据映射 / 拉取缓存
└── view/                        ← /connect-providers 交互
```

## 为什么需要它

OpenCode 的供应商清单来自 models.dev 目录，**目录里没有的供应商不会出现在 `/connect`**。
想用自建/网关/小众供应商，原本只能在 `opencode.json` 里手写 `providers.<id>` 加一长串模型参数。
本项目把这份数据搬到一份共享注册表里，由插件在运行期注册 —— 配置零增长，改注册表也不用改插件版本。

## 安装

```bash
# Linux / macOS
./install.sh
```

```powershell
# Windows
.\install.ps1
```

脚本把 `.opencode/plugins/opencode-providers/` 整目录装到：

```
~/.config/opencode/plugins/opencode-providers/        # $XDG_CONFIG_HOME 优先
```

装完**重启 opencode**（或 `opencode service restart`）生效。卸载：`./uninstall.sh` / `.\uninstall.ps1`。

## 使用

```
/connect-providers        # 选供应商 → 贴 API Key
/models                   # 该供应商的模型随即出现在列表里
```

再运行一次可以添加第二个账号，或在已有账号之间切换。

**为什么 `/models` 里一开始看不到新供应商**：provider 声明为 `activation: "auto"`，
只有拿到凭据（你在 `/connect-providers` 里存过 key）后才会出现在 `/models`。
这样就算注册表里有几十家供应商，也只会显示你真正配了 key 的那些。

凭据存在 opencode 自己的 SQLite 里（`opencode debug paths db`），和内置 `/connect` 完全一致。
API Key 只在你贴入时经过本插件的内存，不落任何本项目自己的文件。

## 维护注册表

改 `registry.json` 提交后，运行中的 opencode 最迟 6 小时（TTL）自动跟上；想立刻生效就重启服务。
拉取使用 `ETag`，内容没变时不会重复下载；网络失败时继续沿用本地缓存，不会把供应商列表清空。

### 结构

```jsonc
{
  "schemaVersion": 1,
  "models": {
    // 供应商无关的模型参数，写一份，被下面 provider 用 "base" 引用
    "some-model": {
      "name": "Some Model",
      "limit": { "context": 131072, "output": 16384 },
      "cost": { "input": 0.5, "output": 1.5, "cache_read": 0.05 },
      "tools": true,
      "input": ["text", "image"],
      "output": ["text"]
    }
  },
  "providers": {
    "my-gateway": {
      "name": "My Gateway",
      "package": "@opencode/ai/providers/openai-compatible",
      "baseURL": "https://llm.example.com/v1",
      "keyLabel": "Paste API key",
      "models": {
        // key = 在 opencode 里使用的模型 ID；base 指向上面那份共享参数
        "some-model": { "base": "some-model" },
        // 覆盖任意字段；modelID 是发给上游的真实 ID
        "some-model-fast": {
          "base": "some-model",
          "modelID": "some-model-2026-01",
          "cost": { "input": 0.2, "output": 0.8 }
        }
      }
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `schemaVersion` | 当前为 `1`；插件只接受自己支持的版本，不匹配就整份拒绝（不会半注册） |
| `providers.<id>.package` | 运行时包，如 `@opencode/ai/providers/openai-compatible`（**不要**用旧的 `aisdk:` / `@ai-sdk/*` 写法） |
| `providers.<id>.baseURL` | API 端点；与 `settings` 合并后作为 provider `settings` |
| `providers.<id>.keyLabel` | `/connect-providers` 里 API Key 输入框的提示，默认 `Paste API key` |
| `providers.<id>.models` | key = 模型 ID（`provider/model` 里的 model 段）；每项字段见下表 |
| 模型 `base` | 引用顶层 `models` 的 key，先铺共享参数再用本项覆盖 |
| 模型 `modelID` | 发给上游的真实模型/部署 ID，默认等于上面的 key |
| 模型 `limit` | `context` / `output` 必填（无 `base` 时），`input` 可选 |
| 模型 `cost` | 每百万 token 美元；`cache_read`/`cache_write` 可选 |
| 模型 `tools` / `input` / `output` | 能力：是否支持工具调用、输入/输出模态，默认 `true` / `["text"]` |
| 模型 `reasoningField` / `maxTokensField` | 映射到 `Model.Compatibility` |
| 模型 `variants` | `[{ "id": "high", "settings": {} }]` |
| 模型 `status` / `disabled` | 生命周期标记；`disabled: true` 不出现在 `/models` |

`registry.schema.json` 是同一份规则的 JSON Schema，编辑器可直接校验。

## 范围之外

- **不做参数推断**：注册表写什么就是什么，插件不会去猜 `limit`/`cost`。
- **不调供应商 API**：不访问 `/v1/models`，也就没有运行期的额外网络与失败面。
- **不声明 `env` 认证**：本插件只走 `/connect`-式交互；opencode 的 env 是静默旁路且不在 `/connect` 里展示。
- 账号重命名/删除请用内置 `/connect`（同一个 integration，同一个凭据表）。

## 开发

```bash
node --test        # 纯逻辑单测（Node ≥ 22 原生 TS，无需依赖）
```

两个入口的语法/打包检查：

```bash
# server 入口：不 import 任何 @opencode/*，所以没有外部依赖（详见 AGENTS.md 的踩坑记录）
npx --yes esbuild .opencode/plugins/opencode-providers/index.ts --bundle --platform=node --format=esm \
  --outfile=dist/providers-server.js

npx --yes esbuild .opencode/plugins/opencode-providers/tui.tsx --bundle --platform=node --format=esm \
  --jsx=automatic --jsx-import-source=@opentui/solid \
  --external:@opencode/plugin/tui --external:@opentui/solid --external:solid-js --external:@opencode/client \
  --outfile=dist/providers-tui.js
```

改完插件文件**通常无需重启**：插件目录被文件监视，覆盖后自动热重载。
验证是否真的注册成功（用 opencode 自己的 API，不需要看 TUI）：

```bash
opencode api get /api/plugin        # 自己那条 state.status 必须是 active
opencode api get /api/integration   # 注册的供应商（metadata.source = opencode-providers）
opencode api get /api/model         # 只列可用供应商的模型；没配 key 时不会出现
```

本项目**故意没有 `package.json`**：它只通过脚本安装（把插件目录复制到 `plugins/` 下），
不发布 npm，也不支持走 `opencode.json` 的 `plugins` 配置安装（TUI 插件经配置安装会落在 `node_modules` 里，
引入重复的 Solid 运行时，导致只渲染首帧）。
