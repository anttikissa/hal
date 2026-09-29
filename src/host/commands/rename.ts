// Explicit ownership and a cancellable, model-free legacy backfill.
import type { SlashCommand } from '../commands.ts'
import { names } from '../../common/names.ts'
import { naming } from '../naming.ts'

export const command: SlashCommand = {
	help: () => '/rename <name>: set a name. /rename auto (or no argument): automatic naming. /rename backfill: name legacy sessions; repeat to cancel.',
	async run(args, _answers, ctx) {
		let text = args.trim()
		if (text === 'backfill') {
			await naming.backfill(ctx.say)
			return {}
		}
		if (!text || text === 'auto') {
			ctx.setName!(undefined)
			return { say: 'session naming: automatic' }
		}
		try {
			let name = names.validate(text)
			ctx.setName!(name)
			return { say: `session name: ${name}` }
		} catch (e) { return { error: (e as Error).message } }
	},
}
