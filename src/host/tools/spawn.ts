// spawn: opens a session next to the caller's (task t0; subagents.ts).
// The child exists and is working when this returns, so a wait later
// in the same round sees it.

import { statSync } from 'fs'
import { resolve } from 'path'
import type { SpawnKind } from '../../common/session.ts'
import { models } from '../models.ts'
import { subagents } from '../subagents.ts'
import { tabs } from '../tabs.ts'
import type { Tool } from '../tools.ts'

const kinds: SpawnKind[] = ['subagent', 'subagent-leave-open', 'interactive']

function text(input: Record<string, unknown>, key: string): string | undefined {
	let v = input[key]
	if (v === undefined) return undefined
	if (typeof v !== 'string') throw new Error(`${key} must be a string`)
	return v.trim() || undefined
}

export const tool: Tool = {
	name: 'spawn',
	description:
		'Open a session in the tab after this one. A subagent session hands off to this session with send, then its tab ' +
		'closes; subagent-leave-open hands off and stays open; interactive is a session for the user, blank without a task. ' +
		'Don’t restate standing instructions in the task; only add task-specific details.',
	parameters: {
		type: 'object',
		properties: {
			task: { type: 'string', description: 'What the session should do. Required unless kind is interactive.' },
			kind: { type: 'string', enum: kinds, description: 'Default subagent.' },
			mode: { type: 'string', enum: ['fork', 'fresh'], description: 'fork (default) copies this session’s history so far; fresh starts empty.' },
			model: { type: 'string', description: 'Model for the session; default this session’s.' },
			cwd: { type: 'string', description: 'Working directory; default this session’s.' },
			name: { type: 'string', description: 'Brief, descriptive session name, e.g. "Review rendering regression".' },
			limit: { type: 'integer', minimum: 0, description: 'Spawn slots passed on for its own sessions; default 0. This session spends limit + 1.' },
		},
	},
	async run(input, ctx) {
		let kind = (input.kind ?? 'subagent') as SpawnKind
		if (!kinds.includes(kind)) throw new Error(`kind must be one of ${kinds.join(', ')}`)
		let mode = input.mode ?? 'fork'
		if (mode !== 'fork' && mode !== 'fresh') throw new Error('mode must be fork or fresh')
		let limit = input.limit ?? 0
		if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) throw new Error('limit must be a non-negative integer')
		let task = text(input, 'task') ?? ''
		if (!task && kind !== 'interactive') throw new Error('task is required unless kind is interactive')
		let model = text(input, 'model')
		if (model !== undefined && !models.valid(model)) throw new Error(`unknown model ${model}`)
		let cwd = resolve(ctx.cwd, text(input, 'cwd') ?? '.')
		if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${cwd} is not a directory`)
		let id = subagents.spawn(ctx.sessionId, { kind, task, fork: mode === 'fork', cwd, model, name: text(input, 'name'), limit })
		if (kind === 'interactive') return `Opened ${tabs.label(id)} for the user${task ? ', working on the task' : ''}.`
		return `Started ${tabs.label(id)}. It sends its handoff here when done; wait ends this turn until then.`
	},
}
