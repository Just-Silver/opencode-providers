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
      commands: [
        {
          id: `${PLUGIN_ID}.connect`,
          title: "Connect providers",
          slash: { name: "connect-providers" },
          run: () => connectProviders(context),
        },
      ],
    }))
  },
})
