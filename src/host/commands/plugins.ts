// /plugins: this host's plugin files, their hooks, expiry, content hash
// and last load error (task an).

import type { SlashCommand } from '../commands.ts'
import { plugins } from '../plugins.ts'

export const command: SlashCommand = {
	help: () => `/plugins lists the plugin files in ${plugins.dir()}: content hash, expiry, each hook as module.key kind, and the last load error.`,
	run: () => ({ say: plugins.describe() }),
}
