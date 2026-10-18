// /system: inspect exactly the assembled prompt the next provider call uses.
import type { SlashCommand } from '../commands.ts'
import { clock } from '../clock.ts'
import { paths } from '../paths.ts'
import { promptCache } from '../prompt-cache.ts'
import { systemPrompt } from '../system-prompt.ts'

export const command: SlashCommand = {
	help: () => '/system [vars]: show each system prompt source with its byte size, total size, and the full assembled prompt for this session; vars shows the template variables instead.',
	complete: (args) => 'vars'.startsWith(args) ? [{ value: 'vars', description: 'show the template variables for this session' }] : [],
	run(args, _answers, ctx) {
		if (args && args !== 'vars') return { error: 'usage: /system [vars]' }
		let { sources, text, problems, vars = {} } = systemPrompt.inspect(promptCache.input(ctx.sessionId, { cwd: ctx.cwd, model: ctx.model, now: clock.now(), sessionId: ctx.sessionId }))
		let broken = problems.length ? `SYSTEM.md is broken (${systemPrompt.file()}):\n${problems.join('\n')}` : ''
		if (args) {
			let table = Object.entries(vars).map(([name, value]) => `$${name.padEnd(20)} ${value.includes('\n') ? `(${Buffer.byteLength(value)} bytes)` : value}`).join('\n')
			return broken ? { error: `${broken}\n\n${table}` } : { say: table }
		}
		if (broken) return { error: broken }
		let lines = sources.map(({ path, bytes }) => `${bytes} bytes  ${paths.display(path)}`)
		let total = sources.reduce((sum, source) => sum + source.bytes, 0)
		return { say: [...lines, `${total} bytes total`, '', text].join('\n') }
	},
}
