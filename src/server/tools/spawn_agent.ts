import { ipc } from '../file-ipc.ts'
import type { SpawnCommandData, SpawnKind } from '../../common/protocol.ts'
import { sessionIds } from '../session/ids.ts'
import { toolRegistry, type Tool, type ToolContext } from './tool.ts'
import { models } from '../../common/models.ts'
import { sessions } from '../sessions.ts'

const config = { initialLimit: 5 }

function allocate(remaining: number | undefined, requested: number | undefined) {
	if (requested !== undefined && (!Number.isInteger(requested) || requested < 0)) {
		return { error: 'limit must be a non-negative integer' }
	}
	const parentBudget = remaining ?? config.initialLimit
	const childBudget = requested ?? 0
	const needed = childBudget + 1
	if (needed > parentBudget) {
		return { error: `subagent limit ${childBudget} needs ${needed} slots, but only ${parentBudget} remain` }
	}
	return { parentBudget: parentBudget - needed, childBudget }
}

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
		name: raw.name ? String(raw.name) : undefined,
		subagentLimit: raw.limit === undefined ? undefined : Number(raw.limit),
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
	let queued = `Queued subagent spawn ${childSessionId} from ${parentSessionId}`
	if (tab) queued = `Queued subagent spawn ${childSessionId} to tab ${tab} from ${parentSessionId}`
	return `${queued}. Subagent ${childSessionId} is working asynchronously and will report back through an inbox message when finished.`
}

async function execute(input: unknown, ctx: ToolContext): Promise<string> {
	const spec = normalize(input, ctx)
	if (spec.kind !== 'interactive' && !spec.task) return 'error: task is required unless kind is interactive'
	const allocation = allocate(sessions.loadSessionMeta(ctx.sessionId)?.subagentBudget, spec.subagentLimit)
	if ('error' in allocation) return `error: ${allocation.error}`
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
		name: { type: 'string', description: 'Optional session name for the child, brief but descriptive, e.g. "Review rendering regression".' },
		limit: { type: 'integer', description: 'Spawn slots to transfer to the child for recursive delegation. Defaults to 0.' },
	},
	execute,
}

function init(): void {
	toolRegistry.registerTool(spawnAgentTool)
}

export const spawnAgent = { config, allocate, execute, init, plannedChildTab, spawnResult }
