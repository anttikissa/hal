import { ipc } from '../ipc.ts'
import type { SpawnCommandData, SpawnMode } from '../protocol.ts'
import { sessionIds } from '../session/ids.ts'
import { toolRegistry, type Tool, type ToolContext } from './tool.ts'

interface SpawnInput {
	task?: string
	mode?: SpawnMode
	model?: string
	cwd?: string
	title?: string
	closeWhenDone?: boolean
}

function normalize(input: unknown, ctx: ToolContext): Required<Pick<SpawnInput, 'task' | 'mode' | 'cwd' | 'closeWhenDone'>> & Omit<SpawnInput, 'task' | 'mode' | 'cwd' | 'closeWhenDone'> {
	const raw = toolRegistry.inputObject(input)
	return {
		task: String(raw.task ?? '').trim(),
		mode: raw.mode === 'fresh' ? 'fresh' : 'fork',
		model: raw.model ? String(raw.model) : undefined,
		cwd: raw.cwd ? String(raw.cwd) : ctx.cwd,
		title: raw.title ? String(raw.title) : undefined,
		closeWhenDone: Boolean(raw.closeWhenDone),
	}
}

async function execute(input: unknown, ctx: ToolContext): Promise<string> {
	const spec = normalize(input, ctx)
	if (!spec.task) return 'error: task is required'
	const childSessionId = sessionIds.reserve()
	const spawn: SpawnCommandData = { ...spec, childSessionId }
	ipc.appendCommand({
		type: 'spawn',
		sessionId: ctx.sessionId,
		spawn,
	})
	return `Queued subagent spawn ${childSessionId} from ${ctx.sessionId}`
}

const spawnAgentTool: Tool = {
	name: 'spawn_agent',
	description:
		'Spawn a background subagent tab. It can either fork the current session or start fresh, optionally override model/cwd/title, and can auto-close after sending a handoff and finishing.',
	parameters: {
		task: { type: 'string', description: 'What the subagent should do.' },
		mode: { type: 'string', enum: ['fork', 'fresh'], description: 'Whether to fork this session or start with fresh context.' },
		model: { type: 'string', description: 'Optional model override for the child session.' },
		cwd: { type: 'string', description: 'Optional working directory override for the child session.' },
		title: { type: 'string', description: 'Optional tab title for the child session.' },
		closeWhenDone: { type: 'boolean', description: 'If true, the child closes itself after sending a handoff and finishing.' },
	},
	required: ['task'],
	execute,
}

function init(): void {
	toolRegistry.registerTool(spawnAgentTool)
}

export const spawnAgent = { execute, init }
