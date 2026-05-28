import { ipc } from '../ipc.ts'
import type { SpawnCommandData, SpawnKind } from '../protocol.ts'
import { sessionIds } from '../session/ids.ts'
import { toolRegistry, type Tool, type ToolContext } from './tool.ts'

function normalize(input: unknown, ctx: ToolContext): SpawnCommandData {
	const raw = toolRegistry.inputObject(input)
	let kind: SpawnKind = 'subagent'
	if (raw.kind === 'subagent-autoclose' || raw.kind === 'interactive') kind = raw.kind
	return {
		task: String(raw.task ?? '').trim(),
		kind,
		mode: raw.mode === 'fresh' ? 'fresh' : 'fork',
		model: raw.model ? String(raw.model) : undefined,
		cwd: raw.cwd ? String(raw.cwd) : ctx.cwd,
		title: raw.title ? String(raw.title) : undefined,
	}
}

function plannedChildTab(parentSessionId: string): number | undefined {
	const sessions = ipc.readState().sessions
	const parentIndex = sessions.findIndex((session) => session.id === parentSessionId)
	if (parentIndex < 0) return undefined
	const parentTab = sessions[parentIndex]?.tab
	if (Number.isFinite(parentTab)) return Math.floor(parentTab as number) + 1
	return parentIndex + 2
}

function spawnResult(childSessionId: string, parentSessionId: string, kind: SpawnKind): string {
	const tab = plannedChildTab(parentSessionId)
	const label = kind === 'interactive' ? 'interactive session' : 'subagent spawn'
	if (tab) return `Queued ${label} ${childSessionId} to tab ${tab} from ${parentSessionId}`
	return `Queued ${label} ${childSessionId} from ${parentSessionId}`
}

async function execute(input: unknown, ctx: ToolContext): Promise<string> {
	const spec = normalize(input, ctx)
	if (spec.kind !== 'interactive' && !spec.task) return 'error: task is required unless kind is interactive'
	const childSessionId = sessionIds.reserve()
	const spawn: SpawnCommandData = { ...spec, childSessionId }
	ipc.appendCommand({
		type: 'spawn',
		sessionId: ctx.sessionId,
		spawn,
	})
	return spawnResult(childSessionId, ctx.sessionId, spec.kind)
}

const spawnAgentTool: Tool = {
	name: 'spawn_agent',
	description:
		'Spawn a subagent tab or open an interactive session. Subagents can fork the current session or start fresh; interactive sessions open without an initial prompt.',
	parameters: {
		task: { type: 'string', description: 'What the subagent should do. Required unless kind is interactive.' },
		kind: { type: 'string', enum: ['subagent', 'subagent-autoclose', 'interactive'], description: 'subagent sends a handoff and stays open; subagent-autoclose closes after the handoff; interactive opens an idle session for the user.' },
		mode: { type: 'string', enum: ['fork', 'fresh'], description: 'Whether to fork this session or start with fresh context.' },
		model: { type: 'string', description: 'Optional model override for the child session.' },
		cwd: { type: 'string', description: 'Optional working directory override for the child session.' },
		title: { type: 'string', description: 'Optional tab title for the child session.' },
	},
	execute,
}

function init(): void {
	toolRegistry.registerTool(spawnAgentTool)
}

export const spawnAgent = { execute, init, plannedChildTab, spawnResult }
