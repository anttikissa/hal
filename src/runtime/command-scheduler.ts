import type { RuntimeCommand } from '../protocol.ts'

export interface SchedulerHooks {
	afterRun?: (sessionId: string) => Promise<void> | void
	onError?: (sessionId: string, error: unknown) => Promise<void> | void
}

interface SchedulerState {
	maxConcurrent: number
	runCommand: (sessionId: string, command: RuntimeCommand) => Promise<void>
	hooks: SchedulerHooks
	queues: Map<string, RuntimeCommand[]>
	scheduled: string[]
	running: Set<string>
	paused: Set<string>
}

let state: SchedulerState | null = null

function getState(): SchedulerState {
	if (!state) throw new Error('command scheduler not initialized')
	return state
}

function getOrCreateQueue(s: SchedulerState, sessionId: string): RuntimeCommand[] {
	let q = s.queues.get(sessionId)
	if (!q) {
		q = []
		s.queues.set(sessionId, q)
	}
	return q
}

function scheduleSession(s: SchedulerState, sessionId: string): void {
	if (!s.scheduled.includes(sessionId)) s.scheduled.push(sessionId)
	drain(s)
}

function drain(s: SchedulerState): void {
	while (s.running.size < s.maxConcurrent) {
		const idx = s.scheduled.findIndex((id) => {
			if (s.running.has(id)) return false
			if (s.paused.has(id)) return false
			const q = s.queues.get(id)
			return Boolean(q && q.length > 0)
		})
		if (idx < 0) return
		const sessionId = s.scheduled.splice(idx, 1)[0]
		const q = s.queues.get(sessionId)
		if (!q || q.length === 0) continue
		const command = q.shift()!
		s.running.add(sessionId)
		void runOne(s, sessionId, command)
	}
}

async function runOne(
	s: SchedulerState,
	sessionId: string,
	command: RuntimeCommand,
): Promise<void> {
	try {
		await s.runCommand(sessionId, command)
	} catch (error) {
		await s.hooks.onError?.(sessionId, error)
	} finally {
		s.running.delete(sessionId)
		const q = s.queues.get(sessionId)
		if (q && q.length > 0) scheduleSession(s, sessionId)
		await s.hooks.afterRun?.(sessionId)
		drain(s)
	}
}

export function createCommandScheduler(
	maxConcurrent: number,
	runCommand: (sessionId: string, command: RuntimeCommand) => Promise<void>,
	hooks: SchedulerHooks = {},
): void {
	state = {
		maxConcurrent,
		runCommand,
		hooks,
		queues: new Map(),
		scheduled: [],
		running: new Set(),
		paused: new Set(),
	}
}

export function ensureSessionQueue(sessionId: string): void {
	getOrCreateQueue(getState(), sessionId)
}

export function removeSessionQueue(sessionId: string): void {
	const s = getState()
	s.queues.delete(sessionId)
	for (let i = s.scheduled.length - 1; i >= 0; i--) {
		if (s.scheduled[i] === sessionId) s.scheduled.splice(i, 1)
	}
	s.running.delete(sessionId)
	s.paused.delete(sessionId)
}

export function totalQueuedCommands(): number {
	const s = getState()
	let total = 0
	for (const q of s.queues.values()) total += q.length
	return total
}

export function sessionQueueLength(sessionId: string): number {
	return getState().queues.get(sessionId)?.length ?? 0
}

export function sessionQueuedCommands(sessionId: string): readonly RuntimeCommand[] {
	return getState().queues.get(sessionId) ?? []
}

export function concurrencyStatus(): { running: number; max: number } {
	const s = getState()
	return { running: s.running.size, max: s.maxConcurrent }
}

export function isSessionRunning(sessionId: string): boolean {
	return getState().running.has(sessionId)
}



export function enqueueCommand(sessionId: string, command: RuntimeCommand): void {
	const s = getState()
	getOrCreateQueue(s, sessionId).push(command)
	scheduleSession(s, sessionId)
}

/** Move the last `prompt` command in a session's queue to position 0. Returns it, or null. */
export function promoteLastPrompt(sessionId: string): RuntimeCommand | null {
	const q = getState().queues.get(sessionId)
	if (!q || q.length === 0) return null
	let lastIdx = -1
	for (let i = q.length - 1; i >= 0; i--) {
		if (q[i].type === 'prompt') { lastIdx = i; break }
	}
	if (lastIdx < 0) return null
	const [cmd] = q.splice(lastIdx, 1)
	q.unshift(cmd)
	return cmd
}

export function drainQueuedCommands(sessionId?: string | null): RuntimeCommand[] {
	const s = getState()
	const dropped: RuntimeCommand[] = []
	if (sessionId) {
		const q = s.queues.get(sessionId)
		if (q) while (q.length > 0) dropped.push(q.shift()!)
		return dropped
	}
	for (const q of s.queues.values()) {
		while (q.length > 0) dropped.push(q.shift()!)
	}
	return dropped
}

/** Remove specific items from a session's queue by 0-based indices. Returns removed commands. */
export function removeQueuedByIndices(sessionId: string, indices: number[]): RuntimeCommand[] {
	const q = getState().queues.get(sessionId)
	if (!q || q.length === 0) return []
	// Sort descending so splicing doesn't shift later indices
	const sorted = [...new Set(indices)].filter(i => i >= 0 && i < q.length).sort((a, b) => b - a)
	const removed: RuntimeCommand[] = []
	for (const idx of sorted) removed.push(q.splice(idx, 1)[0])
	removed.reverse()
	return removed
}

/** Freeze a session's queue — queued commands stay but won't run. */
export function pauseSession(sessionId: string): void {
	getState().paused.add(sessionId)
}

/** Unfreeze a session's queue and kick the scheduler. */
export function resumeSession(sessionId: string): void {
	const s = getState()
	s.paused.delete(sessionId)
	const q = s.queues.get(sessionId)
	if (q && q.length > 0) scheduleSession(s, sessionId)
}

export function isSessionPaused(sessionId: string): boolean {
	return getState().paused.has(sessionId)
}

export function pausedSessionIds(): string[] {
	return [...getState().paused]
}
