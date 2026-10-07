---
name: opencode-providers registry
description: Use when adding or changing providers or models in this repository's registry (registry/index.json manifest + registry/providers/<id>/{provider,models}.json + registry/models/<lab>/<model>.json) — 新增供应商（id / 显示名 / 协议包 / baseURL）、给某家加模型（modelID / limit / 变体）、改 baseURL 或上下文长度，或用户说「维护注册表 / 把某家加进去 / 加个模型」。改用随技能 CLI（.opencode/skills/opencode-providers-registry/scripts/registry.mjs），**不要直接读整份注册表**。
---

# 注册表维护（分文件 + manifest）

注册表是**按供应商拆分的小文件**：`registry/index.json`（manifest：`schemaVersion` / `revision` / `providers`）
+ `registry/providers/<id>/provider.json`（供应商参数）+ `registry/providers/<id>/models.json`（该家模型）
+ 顶层共享模型 `registry/models/<lab>/<model>.json`。`index.json` 与 `revision` 由 CLI 自动维护，**人手不碰**。
插件运行期从 GitHub raw 拉 manifest，按 `revision` 决定要不要重拉各分文件、聚合成一份（6h TTL + `ETag` + 失败沿用旧缓存）。
**改数据不需要发插件版本**，但要让运行中的实例跟上：`git push origin main` → 触发一次插件重载
（`install.ps1 -Local` / 重启 / 或在 `/connect-providers` 弹窗里按 `Ctrl+R` 强制刷新），否则最多等 6h。

## 铁律 0：禁止直接读整份注册表

它会随供应商/模型增长到很大，读一次就废掉大量上下文。**查、搜、加全部走随技能 CLI**（脚本已经做了 schema 校验与冲突拦截），
只在需要看某一家/某个模型时用 `show`：

```bash
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs <子命令> [参数]
```

| 子命令 | 作用 |
|---|---|
| `list [--json]` | 枚举所有供应商 + 各自已注册模型（含有效 `modelID`/`limit`/变体） |
| `search <关键词> [--json]` | 按供应商 id/名称 或 模型 key/名称/`modelID` 搜索 |
| `show <供应商id> [模型key] [--json]` | 只看一家/一个模型的 JSON（不读整份文件） |
| `validate` | 全量校验 + 计数（供应商/模型/顶层共享模型）；并核对 `index.json`/目录/`revision` 一致 |
| `sync` | 重算 `revision` 并重写 `index.json`（手改过子文件后跑它） |
| `add-provider …` | 新增供应商（含首个模型）；id 或 baseURL 冲突直接报错 |
| `add-model …` | 给已有供应商加模型；同一模型 key 冲突直接报错 |
| `add-shared-model …` | 新增顶层共享模型（多家共用同一模型时用） |

只看不写先跑 `list`；不确定有没有再跑 `search`。**所有写命令在落盘前都会重跑 `parseRegistry`，冲突/非法一律退出码 1 且不写文件。**
（调试/演练可用 `--root <注册表目录>` 指向一份副本，不动仓库里的注册表。）

## 两种路由

| 路由 | 场景 | 收集项 |
|---|---|---|
| **A 新增供应商** | 这家还不存在于注册表 | 供应商 id、显示名称、协议（→ package）、baseURL，**外加首个模型**（key、名称、`modelID`、`limit`、变体） |
| **B 给已有供应商加模型** | 供应商已在注册表，只加模型 | 模型 key、显示名称、上游 `modelID`、`limit`、变体 |

> 路由 A 必须带**一个模型**：注册表 schema 要求每个 provider 的 `models` 非空，脚本也据此拒绝空模型。
> 先 `list`/`search` 确认这家还不存在；已存在就走路由 B，别重复建供应商（会撞 id 报错）。

不在本技能范围：改插件代码 / 加 `env` 认证 / 账号重命名删除（CLI 也没有覆盖/删除子命令）。

## 一次性收集：Questions 模板（**原样照搬**）

调用 `question` 工具，把下面模板**整段复制**到 `questions` 数组里；**用户已经给出的字段，从数组里删掉对应问题**，
其余问题原样保留（不要改措辞、不要改顺序、不要新增问题）——这样每次提问都一致。

### 路由 A：新增供应商

```json
{
  "questions": [
    {
      "header": "供应商 id",
      "question": "这家供应商在 opencode 里的 id（`provider/model` 的前缀，小写字母/数字/._-，不含 / 与空格）是什么？",
      "options": [
        { "label": "示例：open-design", "description": "占位——请按上游品牌改成实际 id，如 open-design" }
      ]
    },
    {
      "header": "显示名称",
      "question": "这家供应商在界面里显示的名称是什么？",
      "options": [
        { "label": "示例：Open Design", "description": "占位——显示用名称，可含空格与大小写" }
      ]
    },
    {
      "header": "协议形态",
      "question": "上游接口走哪种协议形态（看上游文档 curl 示例的路径）？",
      "options": [
        { "label": "/v1/chat/completions (默认)", "description": "OpenAI chat → @opencode/ai/providers/openai-compatible" },
        { "label": "/v1/responses", "description": "OpenAI responses → @opencode/ai/providers/openai-compatible/responses" },
        { "label": "/v1/messages", "description": "Anthropic messages → @opencode/ai/providers/anthropic-compatible" }
      ]
    },
    {
      "header": "baseURL",
      "question": "这家供应商的 API baseURL 是什么（通常以 /v1 结尾）？",
      "options": [
        { "label": "示例：https://api.example.com/v1", "description": "占位——请填上游文档里的真实地址" }
      ]
    },
    {
      "header": "首个模型 key",
      "question": "这家第一个模型的 key（opencode 里的模型 id，`provider/key` 的后半段）是什么？",
      "options": [
        { "label": "示例：gpt-5-mini", "description": "占位——按上游模型名填，字母/数字/._-，不含 / 与空格" }
      ]
    },
    {
      "header": "模型显示名称",
      "question": "这个模型的显示名称是什么？",
      "options": [
        { "label": "示例：GPT-5 mini", "description": "占位——展示用名称" }
      ]
    },
    {
      "header": "上游 modelID",
      "question": "发给上游的真实 model id 是什么？",
      "options": [
        { "label": "与模型 key 相同", "description": "不写 modelID，默认等于 key" },
        { "label": "与 key 不同", "description": "请 Type your own 填上游真实 id，如 deepseek/deepseek-v4.1-flash" }
      ]
    },
    {
      "header": "上下文长度",
      "question": "这个模型的 limit.context（总上下文 token 数，按上游文档填整数）是多少？",
      "options": [
        { "label": "示例：1048576", "description": "占位——请 Type your own 填真实数字；缺失就不要写这条模型" }
      ]
    },
    {
      "header": "最大输出",
      "question": "这个模型的 limit.output（单次最大输出 token，按上游文档填整数）是多少？",
      "options": [
        { "label": "示例：393216", "description": "占位——请 Type your own 填真实数字；缺失就不要写这条模型" }
      ]
    },
    {
      "header": "变体（可跳过）",
      "question": "这个模型有需要暴露的推理强度等变体吗？（没有就选第一个）",
      "options": [
        { "label": "无变体", "description": "不写 variants" },
        { "label": "low / high / max", "description": "写入三档 reasoningEffort 变体" },
        { "label": "low / high", "description": "写入两档 reasoningEffort 变体" }
      ]
    },
    {
      "header": "输入模态（可多选）",
      "question": "这个模型能接收哪些输入模态？（可多选；没有任何多模态能力就只选「纯文本」）",
      "multiple": true,
      "options": [
        { "label": "纯文本 (text)", "description": "文本输入；任何模型都应保留这项" },
        { "label": "图片 (image)", "description": "仅当上游是视觉/多模态模型才选" },
        { "label": "音频 (audio)", "description": "上游支持音频输入才选" },
        { "label": "视频 (video)", "description": "上游支持视频输入才选" },
        { "label": "PDF (pdf)", "description": "上游支持 PDF 输入才选" }
      ]
    }
  ]
}
```

### 路由 B：给已有供应商加模型

```json
{
  "questions": [
    {
      "header": "模型 key",
      "question": "要加的模型 key（opencode 里的模型 id，`provider/key` 的后半段）是什么？",
      "options": [
        { "label": "示例：gpt-5-mini", "description": "占位——字母/数字/._-，不含 / 与空格" }
      ]
    },
    {
      "header": "模型显示名称",
      "question": "这个模型的显示名称是什么？",
      "options": [
        { "label": "示例：GPT-5 mini", "description": "占位——展示用名称" }
      ]
    },
    {
      "header": "上游 modelID",
      "question": "发给上游的真实 model id 是什么？",
      "options": [
        { "label": "与模型 key 相同", "description": "不写 modelID，默认等于 key" },
        { "label": "与 key 不同", "description": "请 Type your own 填上游真实 id" }
      ]
    },
    {
      "header": "上下文长度",
      "question": "这个模型的 limit.context（总上下文 token 数，按上游文档填整数）是多少？",
      "options": [
        { "label": "示例：1048576", "description": "占位——请 Type your own 填真实数字" }
      ]
    },
    {
      "header": "最大输出",
      "question": "这个模型的 limit.output（单次最大输出 token，按上游文档填整数）是多少？",
      "options": [
        { "label": "示例：393216", "description": "占位——请 Type your own 填真实数字" }
      ]
    },
    {
      "header": "变体（可跳过）",
      "question": "这个模型有需要暴露的推理强度等变体吗？（没有就选第一个）",
      "options": [
        { "label": "无变体", "description": "不写 variants" },
        { "label": "low / high / max", "description": "写入三档 reasoningEffort 变体" },
        { "label": "low / high", "description": "写入两档 reasoningEffort 变体" }
      ]
    },
    {
      "header": "输入模态（可多选）",
      "question": "这个模型能接收哪些输入模态？（可多选；没有任何多模态能力就只选「纯文本」）",
      "multiple": true,
      "options": [
        { "label": "纯文本 (text)", "description": "文本输入；任何模型都应保留这项" },
        { "label": "图片 (image)", "description": "仅当上游是视觉/多模态模型才选" },
        { "label": "音频 (audio)", "description": "上游支持音频输入才选" },
        { "label": "视频 (video)", "description": "上游支持视频输入才选" },
        { "label": "PDF (pdf)", "description": "上游支持 PDF 输入才选" }
      ]
    }
  ]
}
```

## 用 CLI 写（路由 A / B）

路由 A —— 供应商 + 首个模型一次建好（`--protocol` 见下表；`--variant` 可多次给）：

```bash
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs add-provider \
  --id open-design --name "Open Design" \
  --baseurl https://api.open-design.ai/v1 --protocol chat \
  --model open-design-chat --model-name "Open Design Chat" \
  --model-id open-design-chat-v1 \
  --context 131072 --output 32768 \
  --variant 'low:{"reasoningEffort":"low"}' --variant 'high:{"reasoningEffort":"high"}'
```

路由 B —— 给已有供应商加模型：

```bash
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs add-model \
  --provider r4-coder --key r4-mini --model-name "R4 Mini" \
  --context 64000 --output 8000
```

要点：

- `limit` 要写就写全：`--context` 与 `--output` 必须同时给；**都没给又没用 `--base` 会直接报错**（参数不猜）。
- **能力项必须问过用户再写**：用户选了「图片/音频/…」就用 `--input text,image`（逗号分隔、必须含 `text`）。
  不写 `--input` 时插件按默认处理（当前默认是纯文本 `["text"]`，即「识别不了图」）——所以要开图片**必须显式写**。
  工具调用能力**不写**（不在最小配置里，默认继承上游/宿主）。
- `--model-id` 省略（或等于 key）就不写 `modelID`；`--model-name` 省略就不写 `name`（**不会**拿供应商名顶替）。
- 模型与某个已存在的**顶层共享模型**参数完全一致时，用 `add-model --base <lab>/<model>` 引用，别复制一份（见下节）。
- `add-provider` 的 `--baseurl` 若已被别家占用会报错，确属有意才加 `--force`。

## 铁律：只用最小字段（由 CLI 强制）

CLI **只**接受这些字段并据此写文件，其它一律不给入口：

- provider 级 → `name`、`package`（或 `--protocol`）、`baseURL`、`models`
- 模型级 → `name`、`modelID`、`limit`（`context`/`output`）、`variants`（`id` + 可选 `settings`）、`base`
- 模型**能力**（可选，**必须用多选问过用户后再写**）→ `input`（输入模态，逗号分隔、必须含 `text`，如 `["text","image"]`）

**不要** `keyLabel`（默认就是 `Paste API key`）、`settings`、`headers`、`body`、`canonical`、`env`、`apiKey`、
`cost`、`tools`、`family`、`status`、`releaseDate`、`disabled`、`reasoningField`、`maxTokensField`。
（`input` 是**能力事实**，用上面的多选问出来才写；`tools` 不写，默认继承上游。）

- **绝不写 `env` / `apiKey`**：本项目只走 `/connect`，key 存 opencode 自己的凭据表（写进注册表会明文落盘、且绕过 `/connect`）。
- 已有条目里若带了上述字段（历史遗留），**不要**顺手加/删，保持最小改动。

脚本写出来的条目形如（这就是 `add-provider` 的结果，**不要手写**）：

```jsonc
"open-design": {
  "name": "Open Design",
  "package": "@opencode/ai/providers/openai-compatible",
  "baseURL": "https://api.open-design.ai/v1",
  "models": {
    "open-design-chat": {
      "name": "Open Design Chat",
      "modelID": "open-design-chat-v1",
      "limit": { "context": 131072, "output": 32768 },
      "variants": [{ "id": "low", "settings": { "reasoningEffort": "low" } }]
    }
  }
}
```

## 协议 → package（3 种形态，默认第一个）

`--protocol` 就是下表；拿不准看上游文档 curl 示例的路径，不是看模型名字。

| `--protocol` | 上游请求路径 | package |
|---|---|---|
| `chat`（**默认**） | `/v1/chat/completions` | `@opencode/ai/providers/openai-compatible` |
| `responses` | `/v1/responses` | `@opencode/ai/providers/openai-compatible/responses`（OpenAI 官方端点/需要原生行为用 `@opencode/ai/providers/openai/responses`） |
| `messages` | `/v1/messages` | `@opencode/ai/providers/anthropic-compatible`（Anthropic 官方/需要原生行为用 `@opencode/ai/providers/anthropic`） |

拿不准就问用户：「上游是 `/v1/chat/completions`、`/v1/responses` 还是 `/v1/messages`？」
`--protocol` 覆盖不到的原生族（`google`、`google-vertex`、`azure`、`amazon-bedrock`、`openai` 原生、`xai`、`openrouter` 等）
用 `--package <完整包名>` 直传，完整清单见 <https://opencode.ai/v2/docs/providers/#packages>。

> 已核实（**2.0.24**，三层一致）：
> ① 本机源码 `packages/ai/src/providers/{openai-compatible.ts, openai-compatible/responses.ts, anthropic-compatible.ts}` 都在，
> 分别走 `protocols/openai-compatible-chat`、`protocols/openai-compatible-responses`、`protocols/anthropic-messages`；
> ② 发布到 npm 的 `@opencode/ai@2.0.24` 里 `exports["./*"] → ./dist/*.js`，对应产物
> `dist/providers/{openai-compatible.js, openai-compatible/responses.js, anthropic-compatible.js}` 都存在
> —— 也就是 registry 的 `package` 字段在**运行期**能解析（宿主按 `@opencode/ai/<子路径>` import）。

## 同一模型被多家共用：顶层 `models` + `base`

多家提供同一个模型（参数完全相同）时，把**共享参数**写到顶层 `models`，各 provider 用 `base` 引用，再覆盖差异（如 `modelID`）。
本仓实例：共享模型 `deepseek/deepseek-v4.1-flash`（文件 `registry/models/deepseek/deepseek-v4.1-flash.json`）被
`command-code`（`modelID: deepseek/deepseek-v4.1-flash`）与 `r4-coder`（默认 = key）共用。

```bash
# 1) 先建顶层共享模型（只需一次）→ models/<lab>/<model>.json
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs add-shared-model \
  --lab deepseek --key deepseek-v4.1-flash --model-name "Deepseek V4.1 Flash" \
  --context 1048576 --output 393216 --variant low --variant high --variant max

# 2) 各家供应商用 --base <lab>/<model> 引用（差异用 --model-id 覆盖；不写 limit）
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs add-model \
  --provider open-design --key deepseek-v4.1-flash --base deepseek/deepseek-v4.1-flash \
  --model-id deepseek/deepseek-v4.1-flash
```

单家独有、不与别家共用的模型，一律**内联**写在它自己的 `models` 里（`add-model` 默认行为），不要为了"统一"硬抽到顶层。

## 步骤（每次改完都要走完）

1. **先查**：`node … list`（或 `search <关键词>`）确认路由 A/B，并核对现有参数
2. **再写**：`add-provider` / `add-model` / `add-shared-model`（冲突会报错、不会落盘）
3. **自查**：`node … validate`（组装 + schema + index/目录/revision 一致）+ `node … show <供应商id>`（可选）+ `node --test`（含 CLI 分文件读写/sync/冲突用例）
4. `git add -A && git commit -m "…"`（**中文**）→ `git push origin main`
5. 让运行中的实例生效：`pwsh -NoProfile -File .\install.ps1 -Local`（脚本安装）或重启 opencode
6. 验证：
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Just-Silver/opencode-providers/main/registry/index.json   # 200，且 providers 里含新 id（再按需 curl 子文件）
   opencode api get /api/integration   # 新供应商出现，且 metadata.source=opencode-providers
   opencode api get /api/model         # 在 /connect-providers 粘 key 后，模型数与 limit/modelID 对得上
   ```

## 常见错误

| 现象 | 原因 / 处理 |
|---|---|
| 插件 `active` 但注册 0 条 | 注册表不可用：先 `curl` raw `index.json` 是否 200，再 `node … validate` 看是否校验失败 |
| 改完没生效 | 没 push，或没触发重载（TTL 6h 内沿用缓存；`/connect-providers` 弹窗里按 `Ctrl+R` 可强制刷新） |
| `validate` 报 `revision 不一致` | 子文件被手改过；跑一次 `node … sync` 重算 `revision` 再提交 |
| `/api/model` 里没这家 | 正常：`activation: auto`，要在 `/connect-providers` 里存过 key 才出现 |
| 和 `opencode.json` 的 `providers.<id>` 撞名 | 同 id **只留一边**；配置那份还会注入 `activation: enabled` 与明文 key |
| 上游 400/404 | `modelID` 写错：要写**上游真实** id，不是 opencode 里的别名 |
| 变体不生效 | `settings` 必须在 `variants[].settings`，不是模型级 `settings` |
| CLI 报「供应商已存在」/「已存在模型」 | 说明该走路由 B 或换 key；CLI 不做覆盖/改名，别手改 JSON 绕过 |
| CLI 报「未通过 schema 校验」 | 参数组合非法（如 `--base` 指向不存在的共享模型）；按提示改参数重跑（写命令落盘前就校验，失败不写文件） |
