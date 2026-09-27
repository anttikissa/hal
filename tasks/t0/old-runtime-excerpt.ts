
function shouldCloseSessionAfterGeneration(meta: { spawnKind?: SpawnKind } | null | undefined, result: AgentLoopResult): boolean {
	// 'waiting' is a parked turn (the model called wait); it is not a finished
	// generation, so a waiting subagent must not be auto-closed.
	return meta?.spawnKind === 'subagent' && result === 'completed'
}


function promoteSubagentForHumanPrompt(sessionId: string, source?: string): void {
	if (source !== undefined) return
	if (sessionStore.loadSessionMeta(sessionId)?.spawnKind !== 'subagent') return
	sessionStore.updateMeta(sessionId, { spawnKind: 'subagent-leave-open' })
	emitInfo(sessionId, 'Subagent promoted from `subagent` to `subagent-leave-open` - this session will not be closed automatically.')
function buildSpawnPrompt(parentId: string, task: string, kind: SpawnKind, budget = 0): string {
	return [
		`You are a subagent working for parent session ${parentId}.`,
		`You may spawn at most ${budget} additional subagent${budget === 1 ? '' : 's'}.`,
		'',
		'Task:',
		task,
		'',
		`When finished, send a concise handoff to session ${parentId} using the send tool. Include summary, files changed, and open questions.`,
		kind === 'subagent'
			? 'After sending the handoff, finish normally and Hal will close this tab for you.'
			: 'After sending the handoff, leave this tab open for the user to inspect.'
	].join('\n')
}

function queuePromptCommand(sessionId: string, text: string, source?: string, queue?: boolean, sourceTab?: number): void { ipc.appendCommand({ type: 'prompt', sessionId, text, source, queue, sourceTab, createdAt: new Date().toISOString() }) }

function spawnSession(parent: SessionMeta, spec: SpawnSpec): SessionMeta {
	const storedParent = sessionStore.loadSessionMeta(parent.id) ?? parent
	const allocation = spawnAgent.allocate(storedParent.subagentBudget, spec.subagentLimit)
	if ('error' in allocation) throw new Error(allocation.error)
	const mode = spec.mode === 'fresh' ? 'fresh' : 'fork'
	// Resolve model/cwd before creating the tab so the opening summary banner
	// (written during creation) reports the spawned model, not the default.
	const model = models.resolveModel(spec.model || parent.model || models.defaultModel())
	const child = tabs.createSessionTab(
		mode === 'fork'
			? { sourceId: parent.id, sessionId: spec.childSessionId, focus: false }
			: {
				afterId: parent.id,
				sessionId: spec.childSessionId,
				workingDir: spec.cwd || parent.workingDir || process.cwd(),
				model,
				focus: false,
			},
	)
	sessionStore.updateMeta(parent.id, { subagentBudget: allocation.parentBudget })
	const workingDir = spec.cwd || child.workingDir || process.cwd()
	const name = spec.name || child.name
	sessionStore.updateMeta(child.id, {
		workingDir,
		model,
		name,
		spawnKind: spec.kind,
		parentSessionId: parent.id,
		subagentBudget: allocation.childBudget,
	})
	if (mode === 'fresh' || spec.cwd || spec.model) publishContextEstimate(child.id)
	if (spec.kind === 'subagent') {
		tabs.recordSessionInfo(child.id, 'This subagent will close itself after sending a handoff.', new Date().toISOString())
	}
	return sessionStore.loadSessionMeta(child.id) ?? child
}

async function startSpawnedSession(parent: SessionMeta, child: SessionMeta, spec: SpawnSpec): Promise<void> {
	const text = spec.kind === 'interactive' ? spec.task : buildSpawnPrompt(parent.id, spec.task, spec.kind, child.subagentBudget)
	// Blank interactive tab: nothing to inject, just publish it.
	if (!text.trim()) {
		broadcastSessions()
		return
	}
	const ts = new Date().toISOString()
	// The initial prompt is injected by the parent, so it retains its source in
	// the transcript. Keep an explicit recall entry as well: it is the child
	// user's only way to inspect exactly what was started after switching tabs.
	//
	// Write the user entry straight to history instead of emitting a 'prompt'
	// event. Clients learn about the new tab from the session list and build it
	// from history, so a prompt event would race the tab creation and render the
	// same message a second time.
	sessionStore.appendHistory(child.id, [
		{ type: 'input_history', text, ts },
		{ type: 'user', parts: await resolvePromptParts(child.id, text), source: parent.id, ts },
	])
	broadcastSessions()
	await runGeneration(child.id, '')
