// help: exact Action syntax, collected from the tool modules themselves
// (actions.help), never from a separate list (task 3fv).

import { actions } from '../actions.ts'
import { type Tool, tools } from '../tools.ts'

export const tool: Tool = {
	name: 'help',
	action: { summary: false, positional: ['name'], usage: ['HELP', 'HELP <NAME>'] },
	description: 'Explain an action: its syntax, fields, defaults and units. Without a name, list every action with its syntax.',
	parameters: { type: 'object', properties: { name: { type: 'string', description: 'An action name, e.g. EDIT' } } },
	readOnly: true,
	async run(input) {
		if (input.name !== undefined && typeof input.name !== 'string') throw new Error('name must be an action name, e.g. HELP EDIT')
		if (input.name) return actions.help(actions.find(input.name.toLowerCase()))
		let lines = [...tools.all().values()].flatMap((t) => actions.usage(t))
		return [
			'One action per Action call; make independent calls in parallel. Names are case-insensitive.',
			'Arguments are JS string literals, { objects } or [ arrays ] (never evaluated), or bare words on the action line.',
			'HELP <NAME> explains one action.',
			'',
			...lines,
		].join('\n')
	},
}
