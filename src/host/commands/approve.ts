// /approve <call id>: the question of an approval that stayed open
// after its turn went on (turns.release; task 6q5). Answered, it runs
// the held Bash call once in the background or declines it; either way
// the session hears how, as from the call's own job.
import type { SlashCommand } from '../commands.ts'
import { history } from '../history.ts'
import { jobs } from '../jobs.ts'
import { tools } from '../tools.ts'

export const command: SlashCommand = {
	run(args, answers, ctx) {
		if (!answers) return { error: '/approve runs only from its approval question' }
		let id = ctx.sessionId
		let found = history
			.readSync(id)
			.findLast((r) => r.type === 'assistant' && r.block.type === 'tool_call' && r.block.id === args)
		if (found?.type !== 'assistant' || found.block.type !== 'tool_call') return { error: `no tool call ${args}` }
		let call = found.block
		let job = `${id}:${found.n}`
		if (!String(answers.run).startsWith('yes')) {
			jobs.tell(id, job, 'The user declined it; it did not run.')
			return {}
		}
		let input = { ...call.input, background: true }
		void tools
			.run({ ...call, input }, { cwd: ctx.cwd, sessionId: id, model: ctx.model, signal: new AbortController().signal })
			.then((r) => jobs.tell(id, job, `The user approved it: ${r.output}`))
		return {}
	},
}
