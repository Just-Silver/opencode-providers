<!-- 职责：实现者的子代理工具返回模型标记实施与验证计划；不写：重复策略契约、注册表维护、历史功能实现过程。 -->

# 子代理工具返回模型标记实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline execution, or superpowers:subagent-driven-development if the user chooses delegation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让主代理从子代理工具返回末尾知道本次强制指定的模型。

**Architecture:** 沿用服务端执行前覆盖，增加执行后钩子，只追加结果文本。
用覆盖后的输入对象关联本次模型，避免返回时重读策略与并发串值；不增加持久状态。

**Tech Stack:** TypeScript、Node ≥ 24 原生测试、OpenCode V2 工具钩子，无新增依赖。

**Spec:** [子代理统一模型策略](https://github.com/Just-Silver/opencode-subagent-model/blob/main/docs/subagent-model-policy.md#主代理知情边界)（原文件已随独立插件迁出；在线内容待新仓推送）。

## 全局约束

- 精确文案为 `[effective subagent model: provider/model#variant (forced by policy)]`，追加在原返回后，以空行分隔。
- 前台完成与后台启动返回一致处理；不注入系统提示，不增加用户侧提示，不改子代理正文或后台完成通知。
- 保留原有结构化 `output`、`metadata` 和失败状态；不修改注册表、版本号、用户配置或数据库。
- 服务端不运行时导入 `@opencode/*`，不自动提交、推送或发布。

## 审查重点

1. 执行期间策略修改或关闭：返回仍对应这一次调用，不串入新设置。
2. 并发调用倒序返回：各自标记对应的模型，不共享单一“当前模型”。
3. 非 subagent、关闭策略、调用失败：不追加误导的成功模型标记。
4. 后续插件修改输入：不把已经失效的策略覆盖值宣称为生效模型。
5. 执行后钩子注册失败：撤销本次已注册钩子，明确不支持，不留下半启用策略。

### Task 1: 追加标记并覆盖行为回归

**Files:**
- Modify: `plugin/opencode-providers/subagent-model.ts`：宿主结构化类型、执行前后关联、追加返回文本、注册失败清理。
- Modify: `tests/subagent-model.test.ts`：沿用现有存储与宿主边界 fake，扩展为命名钩子。
- Modify: `tests/setup.test.ts`：宿主 fake 按钩子名称区分注册，保留真实入口验证。

**Interfaces:**
- 保持 `registerSubagentModelPolicy(ctx): Promise<SubagentModelHandlers>` 与 RPC 契约不变。
- `tool.hook` 支持 `execute.before` / `execute.after`，返回可 `dispose()` 的注册。
- 执行后事件对齐宿主的 `input`、`status`、`result.content` / `error`；只改成功返回文本。
- 覆盖输入以 `WeakMap<object, string>` 记录；执行后仅处理本次记录且模型未被其他插件替换的输入。
- 字符串返回直接追加；内容块数组追加文本块、保留原内容；无文本返回保留结构化结果并增加标记。

- [x] 扩展宿主边界 fake：按名称运行前后钩子，并支持模拟注册失败与撤销。
- [x] 写失败用例：前台输出与后台启动文本末尾精确追加标记，原输出和元数据不变。
- [x] 写失败用例：并发倒序完成、执行期间改策略/关闭、关闭后新调用不追加、续接与模型无变体。
- [x] 写失败用例：其他工具/失败返回不变、后续插件换模型不误标、数组内容保留、注册失败撤销已注册覆盖。
- [x] 运行 `node --test tests/subagent-model.test.ts tests/setup.test.ts`，确认新行为因未实现而失败。
- [x] 最小实现执行前后钩子与输入弱关联；增加必要的局部宿主接口，不重构无关代码。
- [x] 重跑上述测试，要求全部通过。

### Task 2: 文档与独立验证

**Files:** `docs/subagent-model-policy.md`、`README.md`。

- [x] 更新策略文档现状与边界；README 使用章节加一句行为说明，完整文案只在策略文档维护。
- [x] 运行 `node --test`，要求全量通过。
- [x] 运行 AGENTS.md 中的 server / TUI esbuild 命令及 `npm pack --dry-run`，要求退出码 0。
- [x] 审查 diff，运行 `git diff --check`；确认无注册表、版本、用户配置与临时探针改动。
- [x] 记录验证结果，区分宿主边界模拟验证与未进行的真机子代理验证，不自动提交。

## 验证记录（2026-11-10）

- 基线 `node --test`：160/160；新增行为先验证缺失标记与半注册处理的失败，再实现。
- 定向 `node --test tests/subagent-model.test.ts tests/setup.test.ts`：37/37。
- 全量 `node --test`：170/170；server / TUI esbuild、`npm pack --dry-run`：退出码均为 0。
- `git diff --check`：退出码 0；未修改注册表、版本号、用户配置或真实数据库。
- 撤销钩子本身失败也保持半注册回调禁用，已有单独 RED→GREEN 回归验证。
- 原目录新建功能分支 `feat/subagent-model-result-marker`，未另建 worktree；改动保持未提交，未推送或发布。
- 任务标题使用脚本要求的 `Task N` 关键字；无需为适配验收脚本创建提交，审查对象为工作区 diff。
- 未做真机 TUI 交互或实际供应商子代理请求验证；以上测试的宿主存储与钩子边界使用假件。

## 独立审查结论

- 核心逻辑与真实宿主执行链路一致，审查者独立复跑全量测试 170/170；无 Critical，唯一 Important 为缺少变更日志，已补入 `CHANGELOG.md` 的 Unreleased。
- 计划勾选和验证边界在审查快照生成后已补齐，交付文档为准。
- 非阻塞项暂缓：TUI 不支持提示仍仅提执行前钩子，将在独立插件拆分时统一；原宿主输入形态之外的防御性返回测试保留。
- 不恢复假宿主发事件时的强制注册断言：回滚用例需验证无已注册钩子时输入确实不变；启用覆盖的既有业务用例仍能发现钩子未注册。
- 工具返回本身可在 TUI 中查看，不另加卡片/提示；输入对象被其他插件替换时保守不告知；更晚阶段的模型改写不在保证范围；真机验证仍未进行。
- 未增加调试日志；没有用户需求，不扩大功能范围。
