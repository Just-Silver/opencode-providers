# 设计：注册表的 lab 模型层（canon / provider 两层）

- 日期：2026-10-08
- 状态：**已批准**（2026-10-08 用户确认：全部按推荐；破坏性、不兼容旧数据/旧代码）
- 影响面：`.opencode/skills/opencode-providers-registry/`（SKILL.md + CLI）、`registry/` 数据、`tests/`、`AGENTS.md`、`CONTRIBUTING.md`
- 破坏性：**是**。不兼容旧命令语义，不迁移旧行为（只迁移本仓现有数据）

## 负责什么 / 不写什么

- 负责：注册表「lab 模型层」的规则、CLI 语义、技能提问流程、数据迁移、测试策略。
- 不写：插件运行期行为（`plugin/**` 本次**不改**）、发版流程（本次**不发 npm 版本**）。

## 背景

当前注册表有两层，但**技能规则用反了**：

- `registry/models/<lab>/<model>.json` = 顶层共享模型（canon）
- `registry/providers/<id>/models.json` = 该供应商的模型条目（可 `base` 引用 canon）

技能现行铁律写的是「**单家独有、不与别家共用的模型，一律内联**」，于是只有「第二家来复用」时才可能提升到 canon。问题是：**提升靠 agent 自觉**，脚本既不检测也不强制（软提示只比对顶层 canon，不比对别家内联），canon 层会被架空。

已核实 models.dev（`anomalyco/models.dev`，默认分支 `dev`）的源头规则与之相反：

> ## When to use `base_model` (**blocker**)
> **If the provider did not create the model, the provider entry must use `base_model`.**
> 1. Identify the underlying **lab** model.
> 2. If `models/<lab>/<model>.toml` is missing, **add it** under the lab that made the model, then point `base_model` at it.
> 3. Provider file stays override-only.
>
> ### Exceptions (full inline allowed)
> ① provider **is** the lab；② model is **unique to that host**（private beta alias / fine-tune / 无可归属的 lab 身份）。
> **If you can name the lab model, it belongs in `models/` … Do not skip creating `models/` just because the file did not exist yet.**

实证（Kimi K3）：canon `models/moonshotai/kimi-k3.toml` 只有一份，20+ 家 relay 各自文件名不同（`moonshotai/Kimi-K3.toml` vs `moonshotai/kimi-k3.toml`）却全部 `base_model = "moonshotai/kimi-k3"`。**身份由 lab + 模型名决定，与各家的上流 id 无关。**

其余 `gh` 实证（`anomalyco/models.dev`，默认分支 `dev`）：

| 例 | 文件 | 说明 |
|---|---|---|
| A | `providers/openai/models/gpt-4o-2024-05-13.toml` 全内联，且 `models/openai/gpt-4o-2024-05-13.toml` 存在 | 例外①：provider 自己就是 lab 的第一方 host |
| B | `providers/bailing/models/Ling-1T.toml`、`Ring-1T.toml` 全内联；`models/` 下无对应 canon，全仓无任何 provider base 它 | 例外②：无可归属的 lab |
| C | `providers/cerebras/models/gpt-oss-120b.toml`（直接放 `models/` 根下）→ `base_model = "openai/gpt-oss-120b"` | **文件位置不算数，`base_model` 才是判据** |
| D | `providers/amd/models/DeepSeek-V4.1-Flash.toml` → `base_model` + `[limit]` 覆盖（AMD 报 1048576，lab 记 1_000_000） | provider 覆盖 limit |
| E | 20+ 家 Kimi，文件名各异，全 `base_model = "moonshotai/kimi-k3"` | 身份 = lab + 模型名，与各家 id 无关 |

规模：240 家 provider，relay 绝大多数带 `base_model`；全内联是少数。

## 决策

1. **身份不能用 `modelID`**（各家上流调用名不同，正是 canon 层要吸收的差异）。身份 = **lab + canon key**，由 agent 声明一次。
2. **默认建家族**（对「能归属到某个 lab」的模型），不等复用。复用 = 引用同一个 canon，**不做任何自动检测**。
3. **例外（本家独有 / `--inline`）**：模型**没有可归属的 lab**（自研 / fine-tune / 私有 beta 别名）→ 全量内联。
   **判据是「能不能说出造它的 lab」，不是「有几家在卖」**：某家**独家代理**的模型仍是 lab 造的 → 照样要建 canon。
   （本仓三家都是转售网关，暂无此例外；保留 `--inline` 作为逃生口，避免被迫编造假 lab。）
4. **provider 层 override-only**：只写与 canon 的**真实差异**（上流 `modelID`、更小的 limit、真实模态差异）。
5. 本仓 lab id 自定，**不强制与 models.dev 一致**；本次 Kimi 用 **`kimi`**（非 models.dev 的 `moonshotai`）。

## 数据形态（结构不变，用法变）

```
registry/models/<lab>/<model>.json      canon：name / limit / variants / input（provider 无关）
registry/providers/<id>/models.json     { "<key>": { "base": "<lab>/<model>", "modelID"?: "…", …差异 } }
```

`registry/schema.ts` **不改**：已支持 `base` 叠加覆盖、`base` 必须指向存在的 canon、内联（无 base）必须自带 `limit`。

## CLI 变更（破坏性）

`add-model` / `add-provider` 的模型来源改为**三选一必填**（不再有「默认内联」）：

| 标志 | 语义 | 校验 |
|---|---|---|
| `--lab <lab>` | 建 canon `models/<lab>/<key>.json`；参数写进 canon | canon 已存在 → 报错，提示改用 `--base` |
| `--base <lab>/<model>` | 引用已有 canon | canon 不存在 → 报错 |
| `--inline` | 本家独有 → 内联 | 必须自带 `--context`/`--output` |

- `--lab-key <name>`：canon key，默认 = 供应商模型 key（Kimi 场景两者相同，故可省）。
- `--model-id <id>`：语义不变，始终写在 **provider 层**（该家发往上游的真实 id）。
- **limit 是差异，不是来源**：`--base` 时若同时给 `--context`/`--output`，表示「这家 host 的 limit 与 canon 不同」→ 写进 **provider 层覆盖**（如被限流到更小 context 的转售商），canon 不动。`--lab` 时给 limit 才是写 canon。
- lab / canon key 遵循既有 id 规则（小写字母/数字/`._-`，不含 `/`）。
- `add-shared-model` **保留**（canon 的手工入口）。
- **删除自动清理**：`remove-provider` / `remove-model` 之后，**没有任何引用者**的 canon 自动删除并打印。保证「先建后引」的中间态不残留孤儿、`check --strict` 恒绿。
- `check` 新增守护：**两个 canon 参数完全相同** → 提醒（重复家族信号）。

## 技能变更（SKILL.md）

1. **铁律改写**：删掉「单家独有…一律内联」，改为
   > **lab 造的模型一律建 canon（`--lab`）；只有本家独有/无可归属 lab 才 `--inline`。**
2. **新增提问分支（本次重点）**：`search` 未命中任何 canon/家族时，**必须问用户家族标签**：

   ```
   header: 家族标签（lab）
   question: 这个模型归属的 lab（家族标签）id 是什么？
             （决定 canon 落在 models/<lab>/<model>.json；没有可归属的 lab 就选「本家独有」）
   options:
     - 本家独有（--inline）
     - <新建 lab，请 Type your own 填 lab id，如 kimi>
   ```
   命中 canon → **不问**，直接 `--base <canon>`；canon 参数与这家不同处（如更小的 context）写进 provider 层覆盖。
3. **路线 C 措辞修正**：「命中内联模型」不再是常规提升路径（内联应仅存在于本家独有）；改为「命中**别家内联** → 提示可能需要提升为 canon」。
4. **writing-skills Iron Law**：本次改 SKILL.md 必须
   - **RED**：先跑基线（用**未改动**的技能跑一遍「新增一个无 canon 的模型」场景），记录 agent 的偏差行为（如：不问标签、直接内联、自行编 lab）。
   - **GREEN**：改技能，重跑同场景，验证 agent 会问标签并走 `--lab`。
   - **REFACTOR**：补漏（把基线里出现的合理化说法写进技能的反例/红线）。

## 数据迁移

- `kimi-k3`（现内联在 `providers/r4-coder/models.json`）→ 新建 `models/kimi/kimi-k3.json`（照抄 name `Kimi K3` / limit `1048576`/`131072` / variants `low,high,max` / input `text,image,video`），r4-coder 条目改为 `{ "base": "kimi/kimi-k3" }`（无 `modelID`，因 = key）。
- 复核其余条目：`deepseek/deepseek-v4.1-flash` 及三家引用已合规，不动。

## 测试策略

- **保持既有不变量：改注册表数据零改测试**（见 AGENTS.md「运行与验证」铁律）。
- `tests/registry-cli.test.ts`：锚点供应商改用 `--lab` / `--base` / `--inline` 三种形态；新增用例
  - `--lab` 建 canon（含 `--lab-key` 与 key 不同）
  - `--lab` 撞已存在 canon → 报错
  - `--base` 悬空 → 报错
  - 三选一必填（都不给 → 报错）
  - 删供应商 / 删模型 → 无引用 canon 自动清理
  - `check` 重复家族提醒
- `tests/registry.test.ts`：动态断言保持（canon 覆盖、override-only、按需拉取、无悬空）。
- `tests/helpers/shipped.ts`：无需改（已是动态）。

## 文档与发布

- 本 spec → `docs/specs/2026-10-08-lab-model-layer-design.md`
- 改 `AGENTS.md`（铁律 + 文档地图）、`CONTRIBUTING.md`（注册表维护一节）
- **不发 npm 版本**：`package.json` 的 `files` 白名单只有 `plugin/**` + CHANGELOG，技能与 CLI 不发布；`plugin/**` 本次不改。

## 已知弱点（不修）

**没有自动检测**，所以「同一个模型被两家用不同 lab 名建了两遍」只能靠技能先 `search` + `check` 提醒发现。引入自动合并需要 identity 推断（`modelID`/参数），已被否掉。models.dev 同样靠人工 review + `bun validate`。

## 非目标

- 不改插件运行期（`plugin/**`）
- 不引入 `labs/` 元数据层或 logo（YAGNI）
- 不做 canon 自动合并 / 自动拆分
