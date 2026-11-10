<!-- 职责：实现者的子代理统一模型功能任务、接口与验收计划；不写：使用教程、设计决策的重复说明、注册表维护。 -->

# 子代理统一模型实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在执行 `subagent` 前强制使用 TUI 配置的全局模型。

**Architecture:** server 注册执行前钩子与策略 RPC，通过宿主 storage 每次读取全局设置。
TUI 使用原生选择弹窗与带 location 的 RPC，服务端负责保存校验。

**Tech Stack:** TypeScript、Node ≥ 24 原生测试、OpenCode V2 插件 API、JSON Schema RPC；不新增运行时依赖。

**Spec:** [子代理统一模型策略](./subagent-model-policy.md)。

**执行结果（2026-11-10）：** 任务 1、2、3 均已完成，主代理规范与质量审查通过；改动保留在
`feat/subagent-model-policy` 的未提交工作区。以下勾选记录实现与验收步骤，不代表已部署到用户环境。

## 全局约束

- 实现代码由 `open-design/deepseek-v4.1-flash#high` 子代理编写；主代理负责规划、审查与独立验证。
- server 不得运行时导入 `@opencode/*`；相对导入带 `.ts`；TUI 不写 JSX。
- 不修改 `registry/**`、版本号、用户配置或真实数据库；不自动提交、推送、发布。
- 不在 location 闭包中缓存策略，不使用定时器或 TTL 传播设置。
- 测试只覆盖本次业务行为；假件限于宿主、存储、网络、UI 等外部边界，其余用真实实现。
- 旧宿主缺失新 API 时保持供应商注册可用，但不得宣称强制策略可用或保存成功。

## 审查重点

1. 模型 ID 自带 `/`：只在第一个 `/` 分隔 provider，按 `#` 分隔变体，不截断模型 ID（任务 1）。
2. 保存失败：不得更改既有策略或出现成功提示（任务 1、2）。
3. 当前模型失效、目录无可用模型：仍可展示当前引用并关闭覆盖（任务 2）。
4. 数据库读取失败或内容损坏：不能静默沿用主代理选的模型（任务 1）。
5. 旧宿主、注册表网络失败：策略与供应商注册互不阻塞（任务 1、2）。

## 文件职责

- `plugin/opencode-providers/subagent-model.ts`：策略存取、模型验证、执行前钩子、RPC handlers，局部结构化宿主接口。
- `plugin/opencode-providers/rpc.ts`：在现有 `registryRpc` 中增加策略方法与输出类型，不引入第二份相同 ID 的注册。
- `plugin/opencode-providers/index.ts`：初始化策略并把 handlers 合入唯一 RPC 注册，不依赖注册表拉取成功。
- `plugin/opencode-providers/view/subagent-model.ts`：TUI 选择模型与变体、保存、错误反馈。
- `plugin/opencode-providers/tui.ts`：新增全局命令；不改变连接供应商命令。
- `tests/subagent-model.test.ts`、`tests/subagent-model-view.test.ts`：对应服务端与交互行为。
- `tests/setup.test.ts`：仅在需要时增加真实入口连接行为，不重复测试模块内部规则。
- `README.md`：新增使用入口；`CONTRIBUTING.md`：模块索引与设计链接；设计文档收录长期契约。

## 任务 1：服务端全局策略与执行前覆盖

**Interfaces:**

- `SubagentModelSummary = { ok: boolean; supported: boolean; model?: string | null; errors?: readonly string[] }`，在 `rpc.ts` 导出。
- RPC `getSubagentModel({})` 与 `setSubagentModel({ model: string | null })` 均返回上述类型；JSON Schema 禁止多余字段。
- `registerSubagentModelPolicy(ctx: SubagentModelContext): Promise<SubagentModelHandlers>`，从 `subagent-model.ts` 导出。
  handlers 提供同名读取与保存方法，兼容 `index.ts` 的现有 RPC handler 类型。
- `SubagentModelContext` 仅声明需要的 `storage`、可选 `tool.hook`、可选 `model.list`；模型项使用宿主真实字段，
  实现前核对本机源码 `D:/Code/Projects/Agents/opencode/packages/plugin/src/promise/adapter.ts` 与模型端点，不能猜返回形态。

- [x] 先写失败用例：策略关闭时输入原样保留；启用时覆盖缺省和显式 `model`，其他输入字段不变、其他工具不变。
- [x] 先写失败用例：两个使用同一存储的实例，A 保存后 B 下一次拦截立即生效；重新注册实例仍可读到保存值。
- [x] 先写失败用例：带 `sessionID` 或 `background` 的调用同样被覆盖；取消覆盖恢复原有输入。
- [x] 先写失败用例：非聊天模型、未知模型、非法变体与非法引用拒绝保存且旧设置不变；模型 ID 包含 `/` 可保存。
- [x] 先写失败用例：关闭不要求模型可用；存储读失败/损坏阻止调用，写失败保留旧设置；无钩子宿主返回不支持。
- [x] 运行 `node --test tests/subagent-model.test.ts`，确认失败原因是缺少待实现行为。
- [x] 实现策略模块：键与值遵循设计；每次读取后替换 `event.input` 为保留其他字段的对象；支持能力不做静默空实现。
  解析语义对齐本机 `packages/schema/src/model.ts` 的 `Model.Ref.parse`，不运行时导入它。
- [x] 扩展 RPC 并接入真实 server 入口；新能力初始化失败不得吞掉 provider 注册，TUI 得到明确不可用结果。
  钩子仅在宿主支持时注册，生命周期由宿主管理；不添加额外 interval。
- [x] 在 `tests/setup.test.ts` 补入口集成用例：注册表不可达时仍可通过真实入口的 RPC 设置策略并影响执行输入。
  可复用既有外部边界 fake ctx，不能新增对随仓数据的硬编码。
- [x] 运行 `node --test tests/subagent-model.test.ts tests/setup.test.ts`，应全部通过；由主代理审查后进入任务 2。

## 任务 2：TUI 可视化配置

**Interfaces:**

- 导出 `configureSubagentModel(ctx: Plugin.Context): Promise<void>`，置于 `view/subagent-model.ts`。
- 命令 ID `opencode-providers.subagent-model`，slash `subagent-model`，`palette: true`，位于既有 `mode: "global"` 图层。
- 消费任务 1 的 RPC，所有请求带 `ctx.location ?? ctx.data.location.default()` 的 location。

- [x] 先写失败用例：可选模型不限本插件、只展示可用聊天模型，显示 provider 与当前完整引用。
- [x] 先写失败用例：选择模型和变体后通过真实策略 handlers 保存；默认变体不拼 `#`。
- [x] 先写失败用例：首层取消、变体层取消均不改变策略；选择关闭保存 `null`。
- [x] 先写失败用例：原选模型已失效/列表为空时仍可关闭；模型读取失败时不误报“无可用模型”。
- [x] 先写失败用例：RPC 带当前 location；保存失败提示错误、策略保持不变；不支持宿主提示不可用。
- [x] 运行 `node --test tests/subagent-model-view.test.ts`，确认出现预期失败。
- [x] 实现原生选择弹窗：当前状态放标题/说明，首项关闭覆盖，模型按供应商分组并可搜索；模型有变体才弹第二层。
  使用类型导入，不能引入 Solid/OpenTUI 运行时；所有异常走错误 toast，不静默保存。
- [x] 接入命令后运行 `node --test tests/subagent-model-view.test.ts tests/connect.test.ts`，应全部通过。
- [x] 更新使用文档、贡献者模块索引与设计状态；不复制存储契约，其他入口链接设计文档。

## 任务 3：主代理审查与独立验收

- [x] 主代理逐文件审查任务 1、2 的 diff，尤其检查 API 真实返回形态、跨 location 策略读取与 fail-closed 边界。
- [x] 若需修正，仍交给指定 Flash 子代理，修完再次审查。
- [x] 运行 `node --test`，要求全部通过。
- [x] 运行两个入口的 esbuild 命令（见 `AGENTS.md`），要求退出码 0。
- [x] 运行 `npm pack --dry-run`，确认新增模块入包、不发布。
- [x] 检查 `git diff --check` 和工作区，确保无探针、未授权的配置/注册表修改。
- [x] 向用户报告实际完成项、验证输出，以及尚未实测的交互边界；不把模拟测试称为真机 TUI 验证。

## 最终验收记录

- 主代理独立执行 `node --test`：160/160 通过。
- server / TUI 两入口 esbuild：退出码均为 0。
- `npm pack --dry-run`：新增策略、界面模块均在白名单包内，未发布。
- `git diff --check`：通过；未修改注册表、版本、用户配置或真实数据库。
- RPC codec 兼容验证结论归属[策略文档](./subagent-model-policy.md#验证与已核实的宿主契约)。
- 未做真机 TUI 点选及实际子代理请求验证，不能据此宣称已部署或已启用。
