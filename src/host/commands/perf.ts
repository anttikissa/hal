// /perf: this host process's startup marks as a waterfall.

import { perf } from '../../common/perf.ts'
import type { SlashCommand } from '../commands.ts'

export const command: SlashCommand = {
	description: 'show startup timing marks',
	category: 'debug',
	help: () => "/perf shows the host process's perf marks: ms since ./run started, then the time since the previous mark.",
	run: () => ({ say: perf.trace() }),
}
