<!-- 职责：开发者与 agent 的子代理统一模型策略设计、存储契约与执行边界；不写：使用教程、供应商注册表数据、通用插件教程。 -->

# 子代理统一模型策略

状态：已实现（服务端执行前钩子 + TUI `/subagent-model` 配置）。

## 目标与范围

通过服务端执行前钩子，确定性覆盖 `subagent` 的 `model`，不依赖主代理遵守提示词。
用户通过 TUI 配置一个全局模型；同一 OpenCode 服务端数据库下的所有项目共享，重启后保留。
第一版不做按 agent 分流，不修改主会话模型，不干预已经执行中的请求，不改注册表。

## 方案选择

- **执行前钩子 + 原生 TUI 弹窗（采用）**：使用 `ctx.tool.hook("execute.before")` 改写输入，
  沿用本插件双入口、原生选择弹窗和 RPC，不引入 JSX 或运行时依赖。
- 包装并替换 `subagent` 执行器：可实现覆盖，但额外耦合内置工具定义，没有必要。
- 提示词约束：不能保证实际工具参数，不能满足需求。
- 自绘 TUI 页面：交互更自由，但当前只有模型、变体与关闭操作，原生弹窗已足够。

## 持久化与全局一致性

- 唯一事实源为服务端 `ctx.storage`，逻辑键 `subagent-model-policy`。
- 保存值为 `{ model: string | null }`；字符串格式为 `providerID/modelID` 或
  `providerID/modelID#variant`，`null` 表示关闭覆盖，缺键同样表示关闭。
- 宿主为键附加插件命名空间后写入 OpenCode SQLite 的 `kv` 表。
  这是持久设置，不使用注册表缓存的 TTL，也不写 TUI 本地存储或 `opencode.json`。
- 每次 `subagent` 执行前读取同一键，不在 location 实例闭包中缓存设置。
  保存成功后的后续读取跨项目生效；已经完成读取的并发调用不追溯修改。
- 只通过宿主存储 API 读写，不直接操作 SQLite 文件。

## 服务端与失败边界

- 执行前钩子只处理有效对象输入的 `subagent`，其他工具不受影响。
- 启用时无条件覆盖 `model`，无论原值缺省还是显式指定；新建、续接、前台和后台调用一致。
- 关闭时保持输入原样，由 OpenCode 按原有规则选择模型，而不是主动删除 `model`。
- RPC 提供读取和保存策略；保存模型时验证当前 location 的可用聊天模型与变体。
  关闭不依赖模型是否仍然可用。
- 已存模型在另一项目不可用或后来失效时，由内置 `subagent` 的模型解析明确报错，不回退。
  数据库读取失败或持久值损坏时也不静默绕过启用策略。
- 缺少钩子能力的宿主不得显示虚假的保存成功；TUI 明确提示功能不可用，供应商注册保持可用。
- 多插件钩子按宿主注册顺序运行，本功能不宣称能抵抗后续其他插件再次改写同一参数。

## TUI 交互

新增全局 slash / 命令面板入口 `/subagent-model`，不改 `/connect-providers` 的职责。
弹窗显示当前策略，提供关闭选项与可搜索的当前 location 可用聊天模型，来源不限本插件。
选择有变体的模型后，再选择默认参数或一个变体；取消任一步不保存。
保存经 RPC 写到服务端，成功或失败以 toast 告知；RPC 显式携带当前 location。
已选模型即使不再可用，也应展示原引用并允许关闭或重新选择。

```text
子代理统一模型（全局）
当前：provider/model#variant（或：未启用）

关闭强制覆盖 — 恢复 OpenCode 原有选择规则
模型名称      — provider/model
模型名称      — provider/model
```

## 验证与已核实的宿主契约

行为测试覆盖强制覆盖、关闭后保留输入、跨 location 即时读取、重新加载后保留、
续接与后台输入、无效选择拒绝保存、TUI 取消不写入及失败提示。
全量 `node --test`、双入口 esbuild 与 npm 打包预检作为回归验证。

已核实的接口依据：

- [官方服务端插件文档](https://opencode.ai/docs/build/plugins/server)：执行前钩子可替换工具输入。
- [官方 TUI 文档](https://opencode.ai/docs/build/plugins/cli)：原生选择弹窗、全局命令与 location 数据。
- [官方 RPC 文档](https://opencode.ai/docs/build/plugins/rpc)：TUI 调用服务端 RPC。
- 主代理以真实 `effect@4.1.0`、同宿主 RPC codec 路径验证：本策略实际输出 schema 的
  `model: null`、带 variant 的模型字符串与 `supported: false` 结果均能成功编解码
  （一次性框架版本验证，不新增框架测试文件）。
- 本机 OpenCode 源码 `packages/core/src/plugin/host.ts` 的 `storage()`：命名空间仅包含插件 ID，不含 location。
- `packages/core/src/tool/plugin/subagent.ts`：显式 `model` 优先于 agent 配置和父会话模型，
  续接也会按显式模型切换；内置解析验证可用聊天模型与变体。
