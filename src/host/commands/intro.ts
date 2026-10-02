// /intro (task vc): switch this tab to hal/intro and start a fresh run
// at once. Its output marks the restart; the intro greets again after it.
import type { SlashCommand } from '../commands.ts'
import { intro } from '../intro.ts'
import { status } from '../status.ts'
import { turns } from '../turns.ts'

export const command: SlashCommand = {
	help: () => '/intro: rerun the first-run guide in this tab; it switches the tab to hal/intro. Answers already saved stay until you change them.',
	run(_args, _answers, ctx) {
		let state = status.stateOf(ctx.sessionId).type
		if (state !== 'idle' && state !== 'paused' && state !== 'error') return { error: 'finish or pause the current turn first' }
		ctx.setModel('hal/intro')
		ctx.say(intro.restart)
		if (!status.transition(ctx.sessionId, { type: 'submit' })) turns.start(ctx.sessionId)
		return {}
	},
}
