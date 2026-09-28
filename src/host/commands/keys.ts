// /keys: every prompt, editing, clipboard and app key (common/key-help.ts).

import { keyHelp } from '../../common/key-help.ts'
import type { SlashCommand } from '../commands.ts'

export const command: SlashCommand = {
	run: () => ({ say: keyHelp.render() }),
}
