// /keys: every prompt, editing, clipboard and app key (common/key-help.ts).

import { keyHelp } from '../../common/key-help.ts'
import type { SlashCommand } from '../commands.ts'

export const command: SlashCommand = {
	description: 'list the keys',
	category: 'help',
	run: () => ({ say: keyHelp.render() }),
}
