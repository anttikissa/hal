// Run a slash command not on the model denylist in the model's own session.
// It takes the same host path as a typed command, including history,
// broadcast, metadata changes and error reporting.
import { commands } from '../commands.ts'
import { slash } from '../slash.ts'
import type { Tool } from '../tools.ts'

const prevented = new Set(['login', 'quit', 'suspend', 'budget', 'queue', 'send'])

export const tool: Tool = {
	name: 'command',
	description: 'Run a model-usable slash command in this session, as if typed by the user. Examples: /cd, /rename, /go, /model. All commands are allowed except /login, /quit, /suspend, /budget, /queue and /send. /restart host|both|all restarts Hal itself, interrupting every session: run it only when the user asked for it or agreed to it, never on your own initiative; ask first. Use the send tool for messaging and queuing. /compact takes effect between rounds and continues this turn; /clear [raw prompt] ends this turn safely, clears context and optionally starts an attributed fresh turn. Later calls in this round do not run after /clear.',
	parameters: { type: 'object', properties: { command: { type: 'string', description: 'Slash command and arguments, e.g. /cd ~/project' } }, required: ['command'] },
	async run(input, ctx) {
		if (typeof input.command !== 'string') throw new Error('command must be a slash command string')
		if (ctx.signal.aborted) throw new Error('turn stopped')
		let text = input.command.trimStart()
		let call = commands.parse(text)
		if (!call) throw new Error('expected a slash command, e.g. /cd ~/project')
		if (prevented.has(call.name)) throw new Error(`/${call.name} is not available to the model${call.name === 'queue' || call.name === 'send' ? '; use the send tool instead' : ''}`)
		return new Promise<string>((resolve, reject) => {
			try {
				let refused = slash.command(ctx.sessionId, text, call, undefined, undefined, (reply) => {
					if (reply.error) reject(new Error(reply.error))
					else resolve(reply.result ?? reply.say ?? (reply.ask ? `/${call.name} needs an answer from the user` : `/${call.name} done`))
				}, 'model')
				if (refused) reject(new Error(refused))
			} catch (error) { reject(error) }
		})
	},
}
