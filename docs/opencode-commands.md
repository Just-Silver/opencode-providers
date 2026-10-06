# opencode 内置命令 vs 插件命令（含 `/connect` 判定）

来源：`E:\Code\Projects\Agent\Externals\opencode` 源码，checkout = v2.0.23，commit `e2d540042a`。
（本地实际运行的 opencode 版本可能不同，但命令表结构与判定方法一致。）

## 结论：`/connect` 是核心内置命令，不是插件

`/connect` 硬编码在 TUI 的核心命令表里，与 `/models`、`/sessions`、`/settings` 同类。

- 命令定义：`packages/tui/src/app.tsx:945-958`
  ```tsx
  {
    name: "provider.connect",
    title: "Connect an integration",
    suggested: !connected(),
    slash: { name: "connect" },     // ← /connect 的来源
    run: () => { dialog.replace(() => <DialogIntegration onConnected={...} />) },
    category: "Integration",
  }
  ```
- 键位项：`packages/tui/src/config/keybind.ts:170`（`"provider.connect": keybind("none", ...)`）；
  v1 别名 `provider_connect`：`packages/tui/src/config/v1/keybind.ts:140`（映射表 `:341`）
- 弹窗实现（内置组件）：`packages/tui/src/component/dialog-integration.tsx:76`（`DialogIntegration`），
  走服务端 API：`/api/integration/:integrationID/connect/key`、`…/connect/oauth`、`…/connect/command`
  （协议定义见 `packages/protocol/src/groups/integration.ts`）

v2 里概念已从 "provider" 泛化为 "integration"（provider 只是其中一类，另一类是 `metadata.source === "mcp"` 的 MCP server）。

## 判定方法：一个 `/xxx` 来自核心还是插件？

两者共用同一套 slash 机制，区别只在「谁注册的」：

| | 核心内置命令 | 插件命令 |
|---|---|---|
| 注册位置 | TUI 源码命令表 `packages/tui/src/app.tsx`（以及 `component/prompt/index.tsx`、`component/session-frame.tsx` 里的内联命令） | 插件运行期经 keymap layer 注入 |
| 形态 | 字面量命令项，直接写 `slash: { name }` | `KeymapCommand`，**必须带 `id`** |
| 约束 | — | `packages/tui/src/context/keymap.tsx:263-264`：`palette`/`slash` 命令缺 `id` 直接抛错 |

插件侧 API（`packages/plugin/src/tui/context.ts`）：

- `KeymapCommand.slash?: { name: string; aliases?: string[]; arguments?: true }`（:423）
- `KeymapCommand.palette?: true`（:421，加入命令面板）
- `KeymapCommand.suggested?: boolean | (() => boolean)`（:430，在发现 UI 里提升排序）
- 注册入口：`ctx.keymap.layer(factory: () => KeymapLayer): void`（`Keymap:470`）；
  层随插件停用或被销毁，factory 需纯函数（先 untracked 跑一次做命令形状校验，之后响应式跑）
- 分发：`ctx.keymap.dispatch(id, input?)`（:472）

示例（插件内注册一个带 slash 的命令）：

```ts
ctx.keymap.layer(() => ({
  // ⚠️ 必须写 mode: "global"（默认是 "base"）—— 见下面「坑」一节，漏了就不会出现在补全列表里
  mode: "global",
  commands: [
    {
      id: "my-plugin.refresh",
      title: "Refresh usage",
      slash: { name: "usage-refresh" },
      run: () => { /* ... */ },
    },
  ],
}))
```

### 坑：漏写 `mode: "global"` → 命令"注册了但看不见"（实测）

- 图层 `mode` 的默认值是 **`"base"`**：`packages/tui/src/context/keymap.tsx:209-214`
  （`...(mode === "global" ? {} : { mode: mode ?? MODE.base })`，`MODE.base = "base"`，`:41`）。
- 输入框里实际生效的模式不是 `base`：`routes/session/composer/index.tsx` 在提示框打开时
  `keymap.mode.push("composer")`；`component/prompt/autocomplete.tsx` 在补全菜单可见时再 push `"autocomplete"`。
  （`ui/dialog.tsx` → `"modal"`，`component/session-tabs.tsx` → `"menu"`，`routes/session/form.tsx` → `FORM_MODE`。）
- `base` 图层在 `composer`/`autocomplete` 模式下**不可达**；补全列表只收集可达命令
  （`autocomplete.tsx:474-483` 遍历 `keymapCommands()`）→ 命令不出现。
- 症状极具迷惑性：`/api/plugin` 里插件 `status: active`、TUI 也加载成功，就是**看不到命令**。
- 正确做法：slash 命令图层写 **`mode: "global"`**（内置插件全部这么写，如
  `feature-plugins/system/plugins.tsx`、`system/stats.tsx`、`prompt/btw.tsx`）。
- 顺带：`palette: true` 让它同时进命令面板；`group` 决定面板分组。
- 触发方式（与内置 `/connect` 一致）：**在补全菜单里选中即执行**（`onSelect: command.run`）；
  若 `slash.arguments` 为假，手打 `/名字` 再回车会被当成普通文本（`prompt/index.tsx` 的回车优先级只认
  `arguments: true` 的 keymap 命令与服务端命令）。

## 同名 slash 命令会怎样（能覆盖/补充 `/connect` 吗）

**能注册同名，但没有去重、没有保留名单、没有覆盖语义 —— 只是并列，属于未定义行为，别做。**

- 补全列表**不去重**：`packages/tui/src/component/prompt/autocomplete.tsx:474-496` 把
  `keymapCommands()` 的每个 `slash.name`+`aliases` 全推一遍，再推服务端命令，最后只排序 → 会出现**两行一模一样的 `/connect`**。
- 键盘执行取**首个命中**：`packages/tui/src/component/prompt/index.tsx:173-183` 的 `argumentSlash` 用
  `commands.find(...)`，顺序 = 注册顺序，谁先注册谁生效。
- 回车优先级（`prompt/index.tsx:1133-1150`）：**带 `arguments: true` 的 keymap 命令** → 服务端命令（`command.name` 命中）→ 普通文本。
- 内置 `/connect` 是「无 arguments」，只能靠补全菜单 `onSelect` 触发（`app.tsx:949`）；手打 `/connect` 回车不会走它，除非命中了同名服务端命令。

**真正的「功能补充」不需要同名命令**：把 integration 注册进 registry，内置 `/connect` 对话框
（`dialog-integration.tsx` 读 `data.location.integration.list()`）里就会自动出现我们的供应商 —— 这正是 A 方案的机制。
插件**无法**往 `DialogIntegration` 里注入 UI（核心 TUI 组件）。

想加命令入口时：

| 想要 | 用什么 | 前提 |
|---|---|---|
| 服务端命令（出现在 slash 列表） | `ctx.command.transform(e => e.add({ name, description, execute }))`（`packages/plugin/src/effect/plugin.ts:32`） | server 插件即可 |
| TUI 命令（可 `slash.args`、可自定义 UI） | `ctx.keymap.layer(() => ({ commands: [{ id, slash: { name, arguments: true }, run }] }))`（`packages/plugin/src/tui/context.ts:557`） | 必须有 **TUI 入口**（`tui.tsx`） |
| 复用内置对话框 | `ctx.keymap.dispatch("provider.connect")`（`Keymap.dispatch`） | 仅 TUI 入口 |

→ 若本项目要做命令，走 **独立名字**（如 `/providers`）+ `ctx.command.transform`（server 即可），别抢 `connect`。

## 与本仓库的关系

`opencode-tui-usage` 目前只提供侧边栏内容（`ctx.ui.sidebar`），未注册任何 slash 命令。
若以后要加命令，按上表用 `ctx.keymap.layer` + 带 `id` 的 `KeymapCommand` 即可，不需要改核心。
