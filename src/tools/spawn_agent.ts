import { ipc } from '../ipc.ts'
import { toolRegistry, type ToolContext } from './tool.ts'

interface SpawnInput {
	task?: string
	mode?: 'fork' | 'fresh'
	model?: string
	cwd?: string
	title?: string
	closeWhenDone?: boolean
}

function normalize(input: any, ctx: ToolContext): Required<Pick<SpawnInput, 'task' | 'mode' | 'cwd' | 'closeWhenDone'>> & Omit<SpawnInput, 'task' | 'mode' | 'cwd' | 'closeWhenDone'> {
	return {
		task: String(input?.task ?? '').trim(),
		mode: input?.mode === 'fresh' ? 'fresh' : 'fork',
		model: input?.model ? String(input.model) : undefined,
		cwd: input?.cwd ? String(input.cwd) : ctx.cwd,
		title: input?.title ? String(input.title) : undefined,
		closeWhenDone: Boolean(input?.closeWhenDone),
	}
}

async function execute(input: any, ctx: ToolContext): Promise<string> {
	const spec = normalize(input, ctx)
	if (!spec.task) return 'error: task is required'
	ipc.appendCommand({
		type: 'spawn',
		sessionId: ctx.sessionId,
		text: JSON.stringify(spec),
	})
	return `Queued subagent spawn from ${ctx.sessionId}`
}

toolRegistry.registerTool({
	name: 'spawn_agent',
	description:
		'Spawn a background subagent tab. It can either fork the current session or start fresh, optionally override model/cwd/title, and can auto-close after sending a handoff.',
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
})

export const spawnAgent = { execute }
