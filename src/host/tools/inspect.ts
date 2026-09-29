// Read-only view of this host and its open tabs, without session histories
// or client addresses/credentials.
import { host } from '../host.ts'
import { models } from '../models.ts'
import { provider } from '../provider.ts'
import { tabs } from '../tabs.ts'
import type { Tool } from '../tools.ts'
import { version } from '../version.ts'

export const tool: Tool = {
	name: 'inspect',
	description: 'Inspect Hal read-only. view "tabs" (the default): open tabs in order with state, model and cwd, plus host pid, version, uptime and client count. view "models": available models by provider and the default.',
	parameters: { type: 'object', properties: { view: { type: 'string', enum: ['tabs', 'models'], description: 'tabs (default) or models' } } },
	readOnly: true,
	async run(input, ctx) {
		if (input.view !== undefined && input.view !== 'tabs' && input.view !== 'models') throw new Error('view must be tabs or models')
		if (input.view === 'models') {
			let ids = models.known()
			let lines = [`Default: ${models.defaultModel()}`]
			for (let name of ['hal', ...Object.keys(provider.state.providers)]) {
				lines.push(`${name}: ${ids.filter((id) => id.startsWith(`${name}/`)).join(', ') || '(none listed)'}`)
			}
			return lines.join('\n')
		}
		let uptime = Math.floor(process.uptime())
		let lines = [`Host PID ${process.pid}; version ${version.state.loaded ?? 'unknown'}; started ${new Date(performance.timeOrigin).toISOString()}; uptime ${uptime}s`, `Clients: ${host.state.clients.size}`]
		for (let [index, tab] of tabs.list().entries()) {
			let state = tab.state.type === 'running' ? `running (${tab.state.phase})` : tab.state.type === 'blocked' ? `asking (${tab.state.reason})` : tab.state.type
			lines.push(`${index + 1}. ${tab.id}${tab.id === ctx.sessionId ? ' (you)' : ''} · ${tab.name} · ${state} · ${tab.model} · ${tab.cwd}`)
		}
		return lines.join('\n')
	},
}
