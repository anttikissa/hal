// Run a shared-list-approved slash command in the model's own session.
// It takes the same host path as a typed command, including history,
// broadcast, metadata changes and error reporting.
import { commandList } from '../../common/commands/list.ts'
import { commands } from '../commands.ts'
import { slash } from '../slash.ts'
import type { Tool } from '../tools.ts'

export const tool: Tool = {
	name: 'command',
	description: 'Run a model-usable slash command in this session, as if typed by the user. Examples: /cd, /rename, /go, /model. Commands that ask for credentials or control the terminal are not allowed.',
	parameters: { type: 'object', properties: { command: { type: 'string', description: 'Slash command and arguments, e.g. /cd ~/project' } }, required: ['command'] },
	async run(input, ctx) {
		if (typeof input.command !== 'string') throw new Error('command must be a slash command string')
		if (ctx.signal.aborted) throw new Error('turn stopped')
		let text = input.command.trim()
		let call = commands.parse(text)
		if (!call) throw new Error('expected a slash command, e.g. /cd ~/project')
		if (!commandList.byName(call.name)?.modelUsable) throw new Error(`/${call.name} is not available to the model`)
		return new Promise<string>((resolve, reject) => {
			try {
				let refused = slash.command(ctx.sessionId, text, call, undefined, undefined, (reply) => {
					if (reply.error) reject(new Error(reply.error))
					else resolve(reply.say ?? (reply.ask ? `/${call.name} needs an answer from the user` : `/${call.name} done`))
				})
				if (refused) reject(new Error(refused))
			} catch (error) { reject(error) }
		})
	},
}
