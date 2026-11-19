// spawn: opens a session next to the caller's (task t0; subagents.ts).
// The child exists and is working when this returns, so a wait later
// in the same round sees it.

import { statSync } from 'fs'
import { resolve } from 'path'
import type { SpawnKind } from '../../common/session.ts'
import { models } from '../models.ts'
import { sessions } from '../sessions.ts'
import { subagents } from '../subagents.ts'
import { tabs } from '../tabs.ts'
import type { Tool, ToolContext } from '../tools.ts'

// Configuration: true puts the whole help in the system prompt; false
// lists only the summary under Other tools (HELP <TOOL> shows the rest).
const inPrompt = false
// Only sessions with a spawn budget see SPAWN under Other tools.
const promptIf = '$spawn_budget'
const summary = 'open a subagent or a session for the user'
const help = `## SPAWN

Open a session in the tab after this one. The task goes between !!START and !!END lines, literally: no quoting or escaping.
SPAWN { kind?, mode?, model?, cwd?, name?, limit?, tools?, systemPrompt? }?
!!START
<task>
!!END
	kind?: "subagent" | "subagent-leave-open" | "interactive"    default "subagent"
	mode?: "fresh" | "fork"    default "fresh"
	model?: string             default this session's
	cwd?: string               default this session's
	name?: string              brief, descriptive session name, e.g. "Review rendering regression"
	limit?: number             child spawn budget; default 0
	tools?: string[]           tools the session may call, e.g. ["read", "grep"]; default this session's
	systemPrompt?: string      replaces the whole system prompt
- subagent reports and closes after a clean finish; subagent-leave-open reports and stays open; interactive opens a session for the user.
- The task holds the goal and constraints, without redundant instructions: the session already has its AGENTS.md, skills and system prompt, so never write "Read AGENTS.md". Required unless kind is interactive.
- fresh starts with only the task; fork copies this session's history so far.
- limit is at most this session's slots left minus 1. Each subagent spawn costs one slot from this session and every ancestor. Interactive sessions are free and use the configured budget.
- tools: [] gives none. A focus aid, not a sandbox: BASH and EVAL can do anything.
- systemPrompt includes AGENTS.md and skills only if asked. Keep it short; weak models do best with only what the task needs. Add as needed: @tools (guides for its tools), $agents (AGENTS.md files), $skills (skill list), $date, $session_cwd.
- A <question> keeps a subagent open; answer through SEND. HELP SUBAGENTS covers coordination and resuming.`

const kinds: SpawnKind[] = ['subagent', 'subagent-leave-open', 'interactive']

// task is required unless kind is interactive, so the schema cannot require it.
const parameters = {
	type: 'object',
	properties: {
		task: { type: 'string' },
		kind: { type: 'string', enum: kinds },
		mode: { type: 'string', enum: ['fork', 'fresh'] },
		model: { type: 'string' },
		cwd: { type: 'string' },
		name: { type: 'string' },
		limit: { type: 'integer', minimum: 0 },
		tools: { type: 'array', items: { type: 'string' } },
		systemPrompt: { type: 'string' },
	},
}

const syntax = {
	usage: ['SPAWN { kind?, mode?, model?, cwd?, name?, limit?, tools?, systemPrompt? }?', '!!START', '<task>', '!!END'],
	block: 'task',
	aliases: { title: 'name', goal: 'task' },
}

function text(input: Record<string, unknown>, key: string): string | undefined {
	let v = input[key]
	if (v === undefined) return undefined
	if (typeof v !== 'string') throw new Error(`${key} must be a string`)
	return v.trim() || undefined
}

async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
	let kind = (input.kind ?? 'subagent') as SpawnKind
	if (!kinds.includes(kind)) throw new Error(`kind must be one of ${kinds.join(', ')}`)
	let mode = input.mode ?? 'fresh'
	if (mode !== 'fork' && mode !== 'fresh') throw new Error('mode must be fork or fresh')
	let limit = input.limit ?? 0
	if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0)
		throw new Error('limit must be a non-negative integer')
	let task = text(input, 'task') ?? ''
	if (!task && kind !== 'interactive') throw new Error('task is required unless kind is interactive')
	let model = text(input, 'model')
	let note = ''
	if (model !== undefined) {
		let selected = models.selection(model)
		if (!models.valid(selected.id)) throw new Error(`unknown model ${model}`)
		model = models.qualified(selected.id, selected.effort)
		if (selected.note) note = ` Effort: ${selected.note}.`
	}
	let cwd = resolve(ctx.cwd, text(input, 'cwd') ?? '.')
	if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${cwd} is not a directory`)
	let tools = input.tools
	if (tools !== undefined && (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string')))
		throw new Error('tools must be an array of tool names')
	let id = subagents.spawn(ctx.sessionId, {
		kind,
		task,
		fork: mode === 'fork',
		cwd,
		model,
		name: text(input, 'name'),
		limit,
		callId: ctx.callId,
		tools: tools as string[] | undefined,
		systemPrompt: text(input, 'systemPrompt'),
	})
	let child = sessions.open(id)
	if (child.tools) note += ` Tools: ${child.tools.map((t) => t.toUpperCase()).join(', ') || 'none'}.`
	if (child.systemPrompt !== undefined) note += ' Custom system prompt.'
	if (kind === 'interactive')
		return `Opened ${tabs.label(id)} for the user${task ? ', working on the task' : ''}.${note}`
	return `Started ${tabs.label(id)}. Its last message comes back here when it finishes; wait ends this turn until then.${note}`
}

export const tool: Tool = { name: 'spawn', inPrompt, promptIf, summary, help, parameters, syntax, run }
