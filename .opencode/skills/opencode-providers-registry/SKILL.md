---
name: opencode-providers registry
description: Use when adding or changing providers or models in this repository's registry (registry/index.json manifest + registry/providers/<id>/{provider,models}.json + registry/models/<lab>/<model>.json) — 新增供应商（id / 显示名 / 协议包 / baseURL）、给某家加模型（**必须声明来源：--lab 建家族 canon / --base 复用 / --inline 本家独有**；modelID / limit / 变体）、**复用已有共享模型（新增前先 search，命中就 --base）**、改参数（set-*）、删除（remove-*），或用户说「维护注册表 / 把某家加进去 / 加个模型 / 改模型删模型」。改用随技能 CLI（.opencode/skills/opencode-providers-registry/scripts/registry.mjs），**不要直接读整份注册表**。
---

# 注册表维护（分文件 + manifest）

注册表是**按供应商拆分的小文件**：`registry/index.json`（manifest：`schemaVersion` / `revision` / `providers`）
+ `registry/providers/<id>/provider.json`（供应商参数）+ `registry/providers/<id>/models.json`（该家模型）
+ 顶层共享模型 `registry/models/<lab>/<model>.json`。`index.json` 与 `revision` 由 CLI 自动维护，**人手不碰**。
插件运行期从 GitHub raw 拉 manifest，按 `revision` 决定要不要重拉各分文件、聚合成一份（6h TTL + `ETag` + 失败沿用旧缓存）。
**改数据不需要发插件版本**，但要让运行中的实例跟上：`node … commit --push` 推到 `origin main` → 触发一次插件重载
（重启 / 或在 `/connect-providers` 弹窗里按 `Ctrl+R` 强制刷新），否则最多等 6h。

> 结构照 **models.dev 的源头那层**：`registry/models/<lab>/<model>.json` ≡ models.dev 的 `models/<lab>/<model>.toml`
> （供应商无关的模型元数据，可被多家复用；models.dev 用 `base_model`，本仓用 `base`），`providers/<id>/…` ≡ 它的 per-provider 层。
> 注意：「**按需拉取**」（运行期聚合只拉 provider 引用到的 `base`）**只约束插件**（省 HTTP）；CLI 跑在本地工作树上，
> `list`/`search` 会列全整棵 `models/**` —— 这正是「新增前先搜、命中就复用」的依据。

## 铁律 0：禁止 agent 直接读 `registry/**` 任何文件

注册表会随供应商/模型增长到很大，agent 读一次就废掉大量上下文。**查、搜、加、改全部走随技能 CLI**——
连 `registry/index.json`（manifest）和单个子文件也不要直接读，需要什么就用 `list` / `search` / `show` 拿：

```bash
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs <子命令> [参数]
```

**红线**：任何时候都不要用 `Read`/`Glob`/`Grep`/`cat`/`Get-Content` 打开 `registry/**`，也不要手改这些 JSON
（`index.json` 与 `revision` 由 CLI 负责）。若你觉得某个操作 CLI 做不到，**先停下来说明**，改用现有命令组合
（例：「改名」= `remove-*` + `add-*`），而不是绕过 CLI 手改文件。

| 子命令 | 作用 |
|---|---|
| `list [--json]` | 枚举所有供应商 + 各自模型 + **顶层共享模型**（含未被引用的） |
| `search <关键词> [--json]` | 按供应商 id/名称、模型 key/名称/`modelID`、**共享模型 ref/名称** 搜索（新增前必跑） |
| `show <供应商id> [模型key]` / `show <lab>/<model>` | 只看一家/一个模型/一个共享模型的 JSON（不读整份文件） |
| `validate` | 组装 + schema + `index.json`/目录/`revision` 一致性 |
| `check [--strict]` | 更全的体检：**悬空 `base` 引用（会害插件整家跳过）**、孤儿共享模型、内联重复、**参数完全相同的两个 canon（重复家族）**、baseURL 重复、`input` 缺 text、空目录；`--strict` 时提醒也算失败 |
| `sync` | 重算 `revision` 并重写 `index.json`（手改过子文件后跑它） |
| `add-provider …` / `add-model …`（**必带来源 `--lab` / `--base` / `--inline`**）/ `add-shared-model …` | 新增（冲突直接报错） |
| `set-provider …` / `set-model …` / `set-shared-model …` | 改参数：**字段补丁**（只改传入的，未传保持）+ `--unset a,b` 清空 |
| `remove-provider …` / `remove-model …` / `remove-shared-model …` | 删除（见「路由」里的安全约束）；删后**自动清理无人引用的 canon** |
| `commit [--message 信息] [--push]` / `push` | **git 交给脚本**：`commit` 按改动自动生成中文提交信息、**只暂存并提交 `registry/**`**（不误伤其他改动）、提交前过 `validate` 级校验；`--push` 顺带推 `origin` 当前分支，`push` 单独推 |

只看不写先跑 `list`；**新增/改之前先 `search`**。**所有写命令在落盘前都会重跑 `parseRegistry`，冲突/非法一律退出码 1 且不写文件。**
（调试/演练可用 `--root <注册表目录>` 指向一份副本，不动仓库里的注册表。）

## 铁律 1：新增模型前先 `search`；再定「来源三选一」（路线 C / lab）

**每次新增模型前先搜一次**（新供应商的首个模型、给已有供应商加模型都一样）：

```bash
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs search "<模型 key / 显示名 / 上游 modelID>"
```

`search` 是**宽松匹配（召回优先）**：归一化（大小写、`. _ / \` 与 `-` 等价、词序无关、忽略版本数字）后**互相包含即命中**——
所以一次搜索**可能召回多个候选**，也可能召回「**相似但不同**」的模型（如搜 `glm-5` 会召回 `glm-5-air`）。命中必须**分档**：

| search 结果 | 处理 |
|---|---|
| **与某 canon/模型归一化后相等**（同一个模型） | **不用提问**，直接 `--base <lab>/<model>` 复用 |
| **召回多个 / 相似但不同** | **用 `"multiple": true` 的 `question` 把候选动态列出**，让用户**二次确认**要复用哪个（或都不复用）——**别自作主张，也别给模糊命中标「推荐」** |
| **无命中** | 走下面的「来源三选一」（先问「家族标签（lab）」） |

> **跨步骤不得沿用上一步的 lab**：即使上一步刚确认过 `glm`，这一步没给归属也**必须重新问**（相似 ≠ 同族）。

输出里「**顶层共享模型**」一节就是可复用候选（= `registry/models/<lab>/<model>.json`）。据命中情况分三种，
**`add-provider` / `add-model` 必须显式声明来源，三者必居其一**（不给就报错）：

| 情况 | 来源标志 | 说明 |
|---|---|---|
| 命中**共享模型** | `--base <lab>/<model>` | 路线 C：直接复用，**不再问** limit / 名称 / 变体 / 模态；只有上游 id 不同才 `--model-id` 覆盖 |
| **没命中**，且能说出**造它的 lab** | `--lab <lab>` | **建家族 canon** `models/<lab>/<model>.json`，参数写进 canon；provider 只写 `base`（+ 可选 `--model-id`） |
| **没命中**，且**本家独有**（私有 beta / 微调 / 无可归属 lab） | `--inline` | 内联写在本供应商里；**必须自带 `--context`/`--output`** |

- **判据是「能不能说出造它的 lab」，不是「有几家在卖」**：**独家代理 ≠ 本家独有**。转售网关卖的第三方模型**要建 canon**。
- **没命中时，必须用 `question` 问用户「家族标签（lab）」**（见模板）——**不许自己编 lab，也不许默认内联**。用户若在任务里已说清归属（如「这是智谱的模型」）即视为已答；**没给出又无法交互（子代理 / CI）时，把要问的问题写清楚并暂停，别猜**。lab / 候选题的选项要**动态**（把 `list` 里**已有的 lab** 列成选项）+ 设 `"multiple": true`（**可多选**）。
- `--lab-key <name>` 让 canon 文件名与 provider 的 key 不同（省略则同名）；canon 已存在同名时 CLI 报错并提示改用 `--base`。
- **`--lab` 撞已存在的 canon 会报错**（报错信息提示改用 `--base`），照做即可；`--base` 指向不存在的 canon 也会报错；
  `--lab`/`--base`/`--inline` **只能给一个**。
- 命中**别家内联模型**（只写在某家 `providers/<id>/models.json`、没进 `models/`）→ `--base` 用不了：`show <id> <key>`
  拿到参数、判断它其实属于哪个 lab → 用 `add-shared-model`（或 `add-model --lab`）建 canon，再让新家 `--base` 引用；
  想顺手把**源** provider 也改成引用，用 `set-model --provider <id> --key <key> --base <lab>/<model> --unset name,limit,variants,input`（清掉内联重复字段）。
- **limit 是「差异」不是「来源」**：`--base` 时给 `--context/--output` = **写在该 provider 层**（覆盖，如被限流的小额度），canon **不动**；
  `--lab` 时给 limit 才是写进 canon。
- **绝不默认内联**：旧规则「单家独有就内联」已废止——「只有一家在卖」不是内联理由。

> **红线（新增模型时，逐条对照）**：
> ① **不许自己编 lab**——没命中就问用户「家族标签（lab）」；
> ② **不许拿「只有一家卖」当内联理由**（独家代理 ≠ 本家独有）；
> ③ **不许跳过 `question` 直接替用户拍板** `--inline` 或 `--lab`；
> ④ **不许手改 `registry/**`**（连 `index.json` 也不行）。

### 反合理化（源自本技能的压力测试）

| 你会对自己说的话 | 事实 |
|---|---|
| 「只有我们一家卖，内联就行」 | **独家代理 ≠ 本家独有**；能说出 lab 就 `--lab` 建 canon |
| 「用户很急，先内联回头再说」 | 一条 `--lab` 命令就收口，省不了步骤；**急 ≠ 可以跳过 `question`** |
| 「lab 不好定，我自己编一个」 | 不许编；没命中就问用户，**问了才算** |
| 「用户没提 lab，那就默认内联」 | 默认内联已废止；没给且无法交互 → **停下提问** |
| 「这是供应商自家的模型，所以内联」 | provider 就是 lab 时 lab 仍说得出来 → 仍 `--lab`（canon 归 lab，不归 provider） |

## 路由

| 路由 | 场景 | 收集项 |
|---|---|---|
| **A 新增供应商** | 这家还不存在于注册表 | 供应商 id、显示名称、协议（→ package）、baseURL，**外加首个模型（含来源三选一：家族标签 lab）** |
| **B 给已有供应商加模型** | 供应商已在注册表，只加模型 | 模型 key、显示名称、**来源三选一（家族标签 lab / `--base` / `--inline`）**、上游 `modelID`、`limit`、变体 |
| **C 复用已有共享模型** | `search` **模糊命中**顶层共享模型（召回多个 / 相似）→ **提问二次确认**；**精确命中（归一化相等）不用问，直接 `--base`** | 供应商信息（仅 A）+ 模型 key + 用哪个共享模型 + 可选 `modelID` 覆盖 |
| **改** | 改供应商/模型/共享模型参数（**含显示名**：`set-provider --name` / `set-model --model-name`） | 用 `set-*`（字段补丁 + `--unset`） |
| **删** | 删供应商/模型/共享模型 | 用 `remove-*`（安全约束见下） |

> 路由 A 必须带**一个模型**：注册表 schema 要求每个 provider 的 `models` 非空，脚本也据此拒绝空模型。
> 确认这家还不存在要**用 `show <id>` 判定**（不存在会明确报错）——别只看 `search`：它是**宽松召回**，别家同 token 也会被命中，不等于这家存在（例：搜 `kimi-gw` 会因 token `kimi` 召回 `kimi-k3`，而 `kimi-gw` 并不存在）。已存在就走路由 B，别重复建供应商（撞 id 会报错）。

删除的安全约束（CLI 强制）：

- `remove-model`：不许删某家**最后一个**模型（会变空，schema 不允许）→ 要删整家用 `remove-provider`。
- `remove-provider`：不许删注册表里**最后一个**供应商。
- `remove-shared-model`：**仍被 `base` 引用就拒绝**（悬空引用会让那家在插件里被整家跳过）。解除引用二选一：
  **删掉引用它的那个模型**用 `remove-model`（**推荐**——纯 `base` 引用的模型没有自己的 limit，`--unset base` 会留下**无 limit 的非法模型**）；
  确实要保留该模型才用 `set-model --provider <id> --key <key> --unset base`，并**同时补齐** `--model-name` / `--context` / `--output`（否则仍非法）。

> **改「显示名」不用 remove+add**：`set-provider --name` / `set-model --model-name` / `set-shared-model --model-name` 即可（保留其它字段，包括 `keyLabel`）。
> 没有独立的「重命名 **id / key（标识）**」命令：改 provider id 或 model key = `remove-*` + `add-*`——**只保留 CLI 能表达的字段**
> （name/package/baseURL/models/模型的 `base` 等），`keyLabel` 之类历史遗留字段会随旧条目消失；遇到就**向用户说明**，别手改 JSON 补回。

不在本技能范围：改插件代码 / 加 `env` 认证。

## 一次性收集：Questions 模板（**原样照搬**）

调用 `question` 工具，把下面模板**整段复制**到 `questions` 数组里；**用户已经给出的字段，从数组里删掉对应问题**，
其余问题原样保留（不要改措辞、不要改顺序、不要新增问题）——这样每次提问都一致。

> 先跑「铁律 1」的 `search`：**精确命中（归一化相等）** → **不用问**，直接 `--base`（及需要时 `--model-id`）。
> **模糊命中（召回多个 / 相似）** → 用下面的**路由 C 模板**把候选动态列出、让用户二次确认；用户选了复用后，再从 A/B 模板里删掉所有模型参数问题
> （key / 名称 / `modelID` / `limit` / 变体 / 输入模态），只在路线 A 时保留供应商信息问题。**没命中** → 才用 A/B 模板逐项问。

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
      "question": "上游接口走哪种协议形态（看上游文档 curl 示例的路径）？只说「OpenAI 兼容」而分不清时，一律按默认 chat。",
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
      "header": "家族标签（lab）",
      "question": "这个模型归属的 lab（家族标签）id 是什么？（**可多选**；决定 canon 落在 models/<lab>/<model>.json；没有可归属的 lab 就选「本家独有」）",
      "multiple": true,
      "options": [
        { "label": "复用已有 lab：<lab>", "description": "**动态填入**——把 list 里已有的 lab（如 deepseek、kimi）各列成一条，用完替换本行；一个都没有就删掉本条" },
        { "label": "本家独有（--inline）", "description": "私有 beta / 微调 / 说不出来源 lab —— 内联写在本供应商里（必须自带 limit）" },
        { "label": "新建 lab，请 Type your own 填 lab id", "description": "如 kimi、deepseek；小写字母/数字/._-，不含 / 。建 models/<lab>/<model>.json 家族 canon" }
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
      "header": "家族标签（lab）",
      "question": "这个模型归属的 lab（家族标签）id 是什么？（**可多选**；决定 canon 落在 models/<lab>/<model>.json；没有可归属的 lab 就选「本家独有」）",
      "multiple": true,
      "options": [
        { "label": "复用已有 lab：<lab>", "description": "**动态填入**——把 list 里已有的 lab（如 deepseek、kimi）各列成一条，用完替换本行；一个都没有就删掉本条" },
        { "label": "本家独有（--inline）", "description": "私有 beta / 微调 / 说不出来源 lab —— 内联写在本供应商里（必须自带 limit）" },
        { "label": "新建 lab，请 Type your own 填 lab id", "description": "如 kimi、deepseek；小写字母/数字/._-，不含 / 。建 models/<lab>/<model>.json 家族 canon" }
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

### 路由 C：模糊命中时二次确认复用（**精确命中不用问，直接 `--base`**）

**动态选项模板**（lab 题见下，同样动态）：把 `search` 宽松召回的候选**逐条**填进 `options`，不要照搬占位文字。

```json
{
  "questions": [
    {
      "header": "复用已有模型",
      "question": "search 宽松召回以下候选（可能不止一个，也可能只是相似）。勾选**与本模型同族**的候选来复用；都不是就选最后一项。",
      "multiple": true,
      "options": [
        { "label": "复用 <lab>/<model>", "description": "search 命中的每一项各列一条。**只有归一化后完全相等才标「推荐」**；相似但不同（如 glm-5 vs glm-5-air）一律不标推荐" },
        { "label": "复用 <另一个命中的 lab/model>", "description": "命中逐条列出；没有第二条就删掉这条" },
        { "label": "都不复用，按来源三选一新增", "description": "回到路线 A/B：先问家族标签（--lab / --inline），再问 limit/变体/模态" }
      ]
    }
  ]
}
```

- 用户点「复用 X」→ `add-provider`/`add-model` 加 `--base X`（需要时再补 `--model-id`）；**不再发 A/B 的模型参数问题**。
- 用户点「不复用」→ 回到 A/B 模板（先问「家族标签（lab）」）。
- 命中是**别家内联模型**（非共享）时：提示用户「该模型可能该提升为 canon，再让两家都 `--base` 引用」；命令走 `add-shared-model`（或 `add-model --lab`）再 `add-*/--base`。

## 用 CLI 写（路由 A / B / C）

路由 A —— 供应商 + 首个模型一次建好（`--protocol` 见下表；`--variant` 可多次给）：

```bash
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs add-provider \
  --id open-design --name "Open Design" \
  --baseurl https://api.open-design.ai/v1 --protocol chat \
  --model open-design-chat --lab open-design --model-name "Open Design Chat" \
  --model-id open-design-chat-v1 \
  --context 131072 --output 32768 \
  --variant 'low:{"reasoningEffort":"low"}' --variant 'high:{"reasoningEffort":"high"}'
```

路由 B —— 给已有供应商加模型（`--lab` 建 canon；**没命中又要内联时用 `--inline`**）：

```bash
# --lab：name / limit / 变体 / --input 都写进 canon；provider 层只写 base（+ 可选 modelID）
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs add-model \
  --provider r4-coder --key r4-mini --lab r4 --model-name "R4 Mini" \
  --context 64000 --output 8000

# 本家独有（说不出来源 lab）：--inline（必须自带 limit）
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs add-model \
  --provider r4-coder --key r4-private --inline --model-name "R4 Private" \
  --context 32000 --output 4000
```

路由 C —— `search` 命中共享模型，直接复用（不重复写 limit/变体）：

```bash
# search 已命中 deepseek/deepseek-v4.1-flash → 加 --base 引用即可
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs add-provider \
  --id open-design --name "Open Design" --baseurl https://amr-link.open-design.ai/v1 \
  --model deepseek-v4.1-flash --base deepseek/deepseek-v4.1-flash
```

改 / 删：

```bash
# 改：字段补丁（只改传入的），--unset 清空；共享模型改动会波及所有引用方
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs set-provider --id r4-coder --baseurl https://api.r4.codes/v2
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs set-provider --id r4-coder --unset baseurl   # 清空 baseURL
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs set-model --provider r4-coder --key deepseek-v4.1-flash --context 200000 --output 64000
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs set-shared-model --lab deepseek --key deepseek-v4.1-flash --unset input
# 删：remove-shared-model 仍被引用会拒绝（先 --unset base 解除引用）
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs remove-model --provider r4-coder --key r4-mini
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs remove-shared-model --ref solo/only
```

要点：

- **`add-model` / `add-provider` 必须声明来源**：`--lab <lab>`（建 canon）/ `--base <lab>/<model>`（复用）/ `--inline`（本家独有）——三者必居其一，不给就报错。`--lab-key` 可让 canon 的文件名与 provider 的 key 不同（省略则同名）。
- `limit` 要写就写全：`--context` 与 `--output` 必须同时给（`set-*` 同理——想只改 `output` 也要把 `--context` 带上原值）；**都没给又没用 `--base` 会直接报错**（参数不猜）。
- **能力项必须问过用户再写**：用户选了「图片/音频/…」就用 `--input text,image`（逗号分隔、必须含 `text`）。
  多选问题的 label 是展示名（如「纯文本 (text)」），传给 `--input` 的是**括号里的英文单词**（`text,image`）。
  按用户勾选如实写（如 `--input text,image`）。**宁可多写、不可少写**——多声明的能力由上游拒绝（无害），少声明则客户端根本用不了该能力；省略 `--input` 走插件兜底 `["text","image"]`（与 opencode 内核一致）。
- `--model-id` 省略（或等于 key）就不写 `modelID`；`--model-name` 省略就不写 `name`（**不会**拿供应商名顶替）。
- 模型与某个已存在的**顶层共享模型**参数一致时，用 `add-*/--base <lab>/<model>` 引用（铁律 1 / 路线 C），别复制一份；`--inline` 写入且参数与某 canon 相同时，CLI 会打一行「可改用 `--base` 复用」的软提示。
- `add-provider` 的 `--baseurl` 若已被别家占用会报错，确属有意才加 `--force`。
- **`set-model` / `set-shared-model` 不能补 `variants`**（`variants` 只在 `add-*` 有入口）：要给已有模型加/改变体，用 `remove-model` + `add-model`（`--inline`/`--lab`/`--base`）重建。

## 铁律：只用最小字段（由 CLI 强制）

CLI **只**接受这些字段并据此写文件，其它一律不给入口：

- provider 级 → `name`、`package`（或 `--protocol`）、`baseURL`、`models`
- 模型级 → `name`、`modelID`、`limit`（`context`/`output`）、`variants`（`id` + 可选 `settings`）、`base`
- 模型**能力**（可选，**必须用多选问过用户后再写**）→ `input`（输入模态，逗号分隔、必须含 `text`，如 `["text","image"]`）

**严格只写上面这些字段**，其余一律不写：`keyLabel`、`settings`、`headers`、`body`、`canonical`、`env`、`apiKey`、
`cost`、`tools`、`family`、`status`、`releaseDate`、`disabled`、`reasoningField`、`maxTokensField`。
用户没给的值不要自己补；已有条目里的其它字段也不要顺手加/删——**除非用户明确要求增删某个字段**。

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
这就是 models.dev 的 `base_model` 那一层。`list`/`search` 会列出所有共享模型（含未被引用的），供「新增前先搜」复用。
本仓实例：共享模型 `deepseek/deepseek-v4.1-flash`（文件 `registry/models/deepseek/deepseek-v4.1-flash.json`）被
`command-code`（`modelID: deepseek/deepseek-v4.1-flash`）、`open-design`、`r4-coder` 共用。

```bash
# 1) 先建顶层共享模型（只需一次）→ models/<lab>/<model>.json
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs add-shared-model \
  --lab deepseek --key deepseek-v4.1-flash --model-name "Deepseek V4.1 Flash" \
  --context 1048576 --output 393216 \
  --variant 'low:{"reasoningEffort":"low"}' --variant 'high:{"reasoningEffort":"high"}' --variant 'max:{"reasoningEffort":"max"}'

# 2) 各家供应商用 --base <lab>/<model> 引用（差异用 --model-id 覆盖；不写 limit）
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs add-model \
  --provider open-design --key deepseek-v4.1-flash --base deepseek/deepseek-v4.1-flash \
  --model-id deepseek/deepseek-v4.1-flash
```

**能说出造它的 lab 的模型，一律 `--lab` 建 canon**（不等复用）；只有**本家独有 / 无可归属 lab** 才 `--inline` 内联。别把「只有一家在卖」当内联理由——**独家代理 ≠ 本家独有**。

## 提交与推送（git 由脚本负责）

**不要手打 git 命令**——`git add -A` 会误收仓库里的无关改动，提交信息也会飘。改完交给脚本：

```bash
node .opencode/skills/opencode-providers-registry/scripts/registry.mjs commit --push
```

- `commit`：**只暂存并提交注册表根（`registry/**`）**，其他已暂存文件原样留着；提交前先跑 `validate` 级校验（不通过**不提交**），并按改动**自动生成中文提交信息**（新增/删除/更新供应商或模型、共享模型…；多条写命令**合成一次提交**）。
- `push`：推送 `origin` 当前分支；`commit --push` = 提交后立即推。
- **推送是显式动作**：建议 `commit` 与 `push` 分开跑，中间留出 `node --test` 复验——测试若失败，本地 `reset`/`amend` 即可，远端与 CI 不受影响；一次性用 `commit --push` 也可以。
- `--message "…"`（或 `-m`）覆盖自动提交信息（一般不用）。
- **副本演练不提交**：`--root` 指向不在 git 仓库里的副本时，`commit`/`push` 会直接明确报错。

## 步骤（每次改完都要走完）

1. **先查（含搜共享模型）**：`node … search "<模型 key / 名称 / 上游 modelID>"` —— 命中共享模型走 C（`--base`）；没命中就问「家族标签（lab）」，据此定 `--lab` / `--inline`；并核对现有参数
2. **再写**：`add-provider` / `add-model`（**必带来源：`--lab` / `--base` / `--inline`**）/ `add-shared-model`；改/删用 `set-*` / `remove-*`（冲突/非法会报错、不会落盘；删除会自动清理无人引用的 canon）
3. **自查**：`node … check`（悬空引用/孤儿/重复…）→ `node … validate`（组装 + schema + index/目录/revision 一致）→ `node --test`
4. **提交/推送交给脚本**（别手打 git）：`node … commit --push` —— 只提交 `registry/**`、自动生成中文提交信息、提交前过校验；想先本地留一手（如提交后再复验）就拆成 `node … commit` → `node … push`
5. 让运行中的实例生效：重启 opencode（或在 `/connect-providers` 里按 `Ctrl+R` 强制刷新）
6. 验证：
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Just-Silver/opencode-providers/main/registry/index.json   # 200，且 providers 里含新 id（再按需 curl 子文件）
   opencode api get /api/integration   # 新供应商出现，且 metadata.source=opencode-providers
   opencode api get /api/model         # 在 /connect-providers 粘 key 后，模型数与 limit/modelID 对得上
   ```

> **只是在副本上演练时**（所有命令都带 `--root <副本目录>`）：跳过上面的 `node --test`（它跑的是**仓库**注册表，对副本无意义）、`commit`/`push`（副本不在 git 仓库里，`commit` 会明确报错）、触发重载与 curl/opencode 验证——副本不参与运行期；演练完删掉副本，别留在机器上。

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
| CLI 报「供应商已存在」/「已存在模型」 | `add-*` 不覆盖：该走路由 B 或换 key；要改/删用 `set-*` / `remove-*`，别手改 JSON |
| `check` 报「悬空引用」 | 某 provider 的 `base` 指向不存在的共享模型（该家会被运行期整家跳过）；`set-model … --unset base` 或补建该共享模型 |
| `remove-shared-model` 报「仍被引用」 | 用 `remove-model` 删掉引用方（**推荐**）；要保留它就 `set-model --unset base` **并补齐 name/limit**（纯 `base` 引用直接 `--unset base` 会变**无 limit 的非法模型**），再删 |
| `check --strict` 退出码 1 | 有提醒（孤儿共享模型/内联重复/baseURL 重复/`input` 缺 text/空目录）；`--strict` 时提醒也算失败，按提示处理或去掉 `--strict` |
| CLI 报「未通过 schema 校验」 | 参数组合非法（如 `--base` 指向不存在的共享模型）；按提示改参数重跑（写命令落盘前就校验，失败不写文件） |
| `validate` 报错但运行期照常 | CLI 是**源码级全量严校验**（连没人引用的共享模型也校验），运行期是**逐家宽松**（坏的那家只跳过、其余照常）；按 CLI 提示修好即可 |
| `add-*` 报「必须指定模型来源」 | 没给 `--lab` / `--base` / `--inline`（铁律 1 三选一）；**别默认内联** |
| `add-*` 报「…已存在，请改用 --base …」 | `--lab` 指向的 canon 已存在；改用 `--base <lab>/<model>` 复用 |
| `add-*` 报「只能给一个」 | `--lab` / `--base` / `--inline` 同时给了；只留一个 |
| 共享模型「说没就没了」 | 删除最后一个引用者时 CLI **自动清理**了无人引用的 canon（并清空空 lab 目录）；要留就别先删引用方 |
| `check` 提醒「参数完全相同的共享模型」 | 两个 canon 参数一模一样（可能重复家族）；确认后 `remove-shared-model` 删其一 |
| `commit` 报「不在 git 仓库里」 | `--root` 指向的是不在任何 git 工作树里的副本；副本演练本来就跳过提交，别在副本上 `commit` |
| `commit` 报「没有要提交的注册表改动」 | 工作区与 HEAD 一致（没改，或已经提交过）；确认写命令真的落盘了 |
| `commit` 报「提交前校验未通过」 | 改动没通过 `validate` 级校验（如手改了 `index.json`/`revision`）；先 `validate` / `sync` 修好再提交 |
| 只想本地提交、暂时不推 | 用 `commit`（不带 `--push`），稍后再 `push`（或直接在弹窗 `Ctrl+R` 前补推） |
| `commit` 提交信息不理想 | 自动信息按 diff 归类；个别措辞不合意就 `--message "…"`（或 `-m "…"`）覆盖（**别**因此回去手打 `git add -A`） |
