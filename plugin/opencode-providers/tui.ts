/**
 * TUI entry — registers `/connect-providers`.
 *
 * The command only *reads* state (integrations the server entry registered) and
 * talks to the server over the client API, so the key still lands in opencode's
 * credential table through the normal `/connect` path.
 */

import { Plugin } from "@opencode/plugin/tui"
import { connectProviders } from "./view/connect.ts"

const PLUGIN_ID = "opencode-providers"

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    context.keymap.layer(() => ({
      // 必须 "global"：图层 mode 默认是 "base"，而提示框里 push 的是 "composer"、
      // 补全菜单可见时还会 push "autocomplete" → base 图层在输入时不可达，slash 命令就不会出现在补全列表里。
      // （内置插件的 slash 命令全部写 mode: "global"，见 feature-plugins/system/plugins.tsx 等。）
      mode: "global",
      commands: [
        {
          id: `${PLUGIN_ID}.connect`,
          title: "Connect providers",
          group: "Integration",
          slash: { name: "connect-providers" },
          palette: true,
          run: () => connectProviders(context),
        },
      ],
    }))
  },
})
