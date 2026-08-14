import { ipc } from '../file-ipc.ts'
import type { SpawnCommandData, SpawnKind } from '../../common/protocol.ts'
import { sessionIds } from '../session/ids.ts'
import { toolRegistry, type Tool, type ToolContext } from './tool.ts'
import { models } from '../../common/models.ts'

function normalize(input: unknown, ctx: ToolContext): SpawnCommandData {
	const raw = toolRegistry.inputObject(input)
	let kind: SpawnKind = 'subagent'
	if (raw.kind === 'subagent-leave-open' || raw.kind === 'interactive') kind = raw.kind
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

function spawnResult(childSessionId: string, parentSessionId: string, kind: SpawnKind, hasTask: boolean): string {
	const tab = plannedChildTab(parentSessionId)
	if (kind === 'interactive') {
		const action = hasTask ? 'and sent initial prompt' : 'blank'
		if (tab) return `Opened interactive session ${childSessionId} in tab ${tab} ${action}.`
		return `Opened interactive session ${childSessionId} ${action}.`
	}
	if (tab) return `Queued subagent spawn ${childSessionId} to tab ${tab} from ${parentSessionId}`
	return `Queued subagent spawn ${childSessionId} from ${parentSessionId}`
}

async function execute(input: unknown, ctx: ToolContext): Promise<string> {
	const spec = normalize(input, ctx)
	if (spec.kind !== 'interactive' && !spec.task) return 'error: task is required unless kind is interactive'
	if (spec.model && !models.modelCompletionNames().includes(models.resolveModel(spec.model))) {
		return `error: Unknown model: ${spec.model}`
	}
	const childSessionId = sessionIds.reserve()
	const spawn: SpawnCommandData = { ...spec, childSessionId }
	ipc.appendCommand({
		type: 'spawn',
		sessionId: ctx.sessionId,
		spawn,
	})
	return spawnResult(childSessionId, ctx.sessionId, spec.kind, !!spec.task)
}

const spawnAgentTool: Tool = {
	name: 'spawn_agent',
	description:
		'Spawn a subagent tab or open an interactive session. Interactive sessions are blank without a task; with a task, Hal sends it as the first visible user prompt immediately. Don’t restate standing instructions in the task; only add task-specific details.',
	parameters: {
		task: { type: 'string', description: 'What the spawned session should do. Required for subagents; optional for interactive sessions.' },
		kind: { type: 'string', enum: ['subagent', 'subagent-leave-open', 'interactive'], description: 'subagent sends a handoff and closes after clean completion; subagent-leave-open sends a handoff but leaves its tab open for user inspection; interactive opens a user-owned session and runs a task when provided.' },
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
