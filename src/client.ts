// Client — connects transport to TUI blocks.

import type { Transport } from './cli/transport.ts'
import type { Block } from './cli/blocks.ts'
import type { CommandType, RuntimeEvent, RuntimeSource, SessionInfo } from './protocol.ts'
import { protocol } from './protocol.ts'
import { replay } from './session/replay.ts'
import { history, type Message } from './session/history.ts'
import { draft } from './cli/draft.ts'
import { prompt } from './cli/prompt.ts'
import { clientState } from './client-state.ts'
import { randomBytes } from 'crypto'
import { resolve } from 'path'

export interface TabState {
	sessionId: string
	blocks: Block[]
	info: SessionInfo
	busy: boolean
	pausing: boolean
	inputHistory: string[]
	inputDraft: string
	contentHeight: number
	context?: { used: number; max: number; estimated?: boolean }
	loadingHistory: boolean
	question?: { id: string; text: string }
	doneUnseen?: boolean
}

export interface ClientState {
	tabs: TabState[]
	activeTabIndex: number
	connected: boolean
}

function selfModeEnabled(): boolean { return process.env.HAL_SELF_MODE === '1' }

function cwdModeTarget(): string | null {
	if (selfModeEnabled()) return null
	const cwd = process.env.LAUNCH_CWD
	if (!cwd) return null
	const halDir = process.env.HAL_DIR ?? resolve(import.meta.dir, '..')
	if (resolve(cwd) === resolve(halDir)) return null
	return resolve(cwd)
}

interface StartupPerfState {
	readyMs: number | null
	hostRuntimeMs: number | null
	cliReadyMs: number | null
	epochMs: number | null
	tabMs: number | null
	hydrateMs: number | null
	renderMs: number | null
	targetMs: number
}

export const clientConfig = {
	startupProgressiveMinMessages: 400,
	startupTailMessageCount: 120,
	startupBackgroundChunkMessages: 120,
	startupUseWorkerForHistory: true,
}

function startupPerfSample(): StartupPerfState | null {
	const meta = (globalThis as any).__hal as {
		startupEpochMs?: number | null
		startupReadyElapsedMs?: number | null
		startupHostRuntimeElapsedMs?: number | null
	} | undefined
	const epochRaw = meta?.startupEpochMs
	const epochMs = typeof epochRaw === 'number' && Number.isFinite(epochRaw) && epochRaw > 0 ? epochRaw : null
	const hostRuntimeRaw = meta?.startupHostRuntimeElapsedMs
	const hostRuntimeMs = typeof hostRuntimeRaw === 'number' && Number.isFinite(hostRuntimeRaw) && hostRuntimeRaw >= 0
		? Math.round(hostRuntimeRaw)
		: null
	const readyRaw = meta?.startupReadyElapsedMs
	if (typeof readyRaw === 'number' && Number.isFinite(readyRaw) && readyRaw >= 0) {
		const readyMs = Math.round(readyRaw)
		const cliReadyMs = hostRuntimeMs === null ? null : Math.max(0, readyMs - hostRuntimeMs)
		return {
			readyMs,
			hostRuntimeMs,
			cliReadyMs,
			epochMs,
			tabMs: null,
			hydrateMs: null,
			renderMs: null,
			targetMs: 100,
		}
	}
	if (!epochMs) return null
	const readyMs = Math.max(0, Date.now() - epochMs)
	const cliReadyMs = hostRuntimeMs === null ? null : Math.max(0, readyMs - hostRuntimeMs)
	return {
		readyMs,
		hostRuntimeMs,
		cliReadyMs,
		epochMs,
		tabMs: null,
		hydrateMs: null,
		renderMs: null,
		targetMs: 100,
	}
}

export class Client {
	private transport: Transport
	private source: RuntimeSource
	private state: ClientState
	private onUpdate: () => void
	private pendingOpen = false
	private pendingStartupPerf: StartupPerfState | null = null
	private startupBackgroundHydration = new Map<string, Promise<void>>()

	constructor(transport: Transport, onUpdate: () => void) {
		this.transport = transport
		this.source = { kind: 'cli', clientId: randomBytes(4).toString('hex') }
		this.state = { tabs: [], activeTabIndex: 0, connected: false }
		this.onUpdate = onUpdate
	}

	getState(): ClientState { return this.state }
	activeTab(): TabState | null { return this.state.tabs[this.state.activeTabIndex] ?? null }

	private contextRatio(tab: TabState): number {
		const max = tab.context?.max ?? 0
		if (max <= 0) return 0
		return (tab.context?.used ?? 0) / max
	}

	private applySelfMode(): void {
		const candidate = this.state.tabs.findIndex(tab => !tab.busy && !tab.pausing && !tab.question && this.contextRatio(tab) < 0.10)
		if (candidate >= 0) {
			this.state.activeTabIndex = candidate
			this.switchToActiveTab()
			return
		}
		if (!this.pendingOpen) {
			this.pendingOpen = true
			void this.send('open')
		}
	}

	private applyCwdMode(target: string): void {
		const candidate = this.state.tabs.findIndex(t => t.info.workingDir === target)
		if (candidate >= 0) {
			this.state.activeTabIndex = candidate
			this.switchToActiveTab()
			return
		}
		if (!this.pendingOpen) {
			this.pendingOpen = true
			const cmd = protocol.makeCommand('open', this.source, undefined, undefined)
			cmd.workingDir = target
			void this.transport.sendCommand(cmd)
		}
	}

	private appendStartupPerfIfPossible(): void {
		if (!this.pendingStartupPerf) return
		const tab = this.activeTab()
		if (!tab) return
		const startupPerf = this.pendingStartupPerf
		if (startupPerf.epochMs !== null && startupPerf.tabMs === null) return
		this.pendingStartupPerf = null
		const targetMs = startupPerf.targetMs
		if (startupPerf.tabMs !== null) {
			const warn = startupPerf.tabMs > targetMs
			const readyPart = startupPerf.readyMs !== null
				? startupPerf.hostRuntimeMs !== null && startupPerf.cliReadyMs !== null
					? `ready ${startupPerf.readyMs}ms (runtime ${startupPerf.hostRuntimeMs}ms + cli ${startupPerf.cliReadyMs}ms) · `
					: `ready ${startupPerf.readyMs}ms · `
				: ''
			const detail = startupPerf.hydrateMs !== null && startupPerf.renderMs !== null
				? ` (hydrate ${startupPerf.hydrateMs}ms + render ${startupPerf.renderMs}ms)`
				: ''
			tab.blocks.push({
				type: 'info',
				text: `${warn ? '⚠ ' : ''}[perf] startup: ${readyPart}tab ${startupPerf.tabMs}ms${detail} (target <${targetMs}ms tab)`,
			})
			return
		}
		if (startupPerf.readyMs === null) return
		const readyLabel = startupPerf.hostRuntimeMs !== null && startupPerf.cliReadyMs !== null
			? `ready ${startupPerf.readyMs}ms (runtime ${startupPerf.hostRuntimeMs}ms + cli ${startupPerf.cliReadyMs}ms)`
			: `ready ${startupPerf.readyMs}ms`
		tab.blocks.push({
			type: 'info',
			text: `${startupPerf.readyMs > targetMs ? '⚠ ' : ''}[perf] startup: ${readyLabel} (target <${targetMs}ms)`,
		})
	}

	private captureStartupTabPerf(hydrateMs: number | null, renderMs: number): void {
		if (!this.pendingStartupPerf) return
		const startupPerf = this.pendingStartupPerf
		if (startupPerf.tabMs !== null) return
		const roundedHydrate = hydrateMs === null ? null : Math.max(0, Math.round(hydrateMs))
		const roundedRender = Math.max(0, Math.round(renderMs))
		startupPerf.hydrateMs = roundedHydrate
		startupPerf.renderMs = roundedRender
		if (startupPerf.epochMs !== null) {
			startupPerf.tabMs = Math.max(0, Date.now() - startupPerf.epochMs)
			return
		}
		if (startupPerf.readyMs !== null && roundedHydrate !== null) {
			startupPerf.tabMs = startupPerf.readyMs + roundedHydrate + roundedRender
		}
	}

	private renderAndCaptureStartup(hydrateMs: number | null): void {
		const shouldCapture = !!this.pendingStartupPerf && this.pendingStartupPerf.tabMs === null && !!this.activeTab()
		if (!shouldCapture) {
			this.appendStartupPerfIfPossible()
			this.onUpdate()
			return
		}
		const renderStartedAt = Date.now()
		this.onUpdate()
		const renderMs = Date.now() - renderStartedAt
		this.captureStartupTabPerf(hydrateMs, renderMs)
		this.appendStartupPerfIfPossible()
		this.onUpdate()
	}

	private async loadHydrationPayload(sessionId: string): Promise<{ replayMessages: Message[]; inputHistory: string[] }> {
		if (this.transport.hydrateSession) return this.transport.hydrateSession(sessionId)
		if (!this.transport.replaySession) throw new Error('transport.replaySession is required when hydrateSession is unavailable')
		const replayMessagesPromise = this.transport.replaySession(sessionId)
		const inputHistoryPromise = history.loadInputHistory(sessionId)
		const [replayMessages, inputHistory] = await Promise.all([replayMessagesPromise, inputHistoryPromise])
		return { replayMessages, inputHistory }
	}

	private async hydrateOlderHistoryInProcess(tab: TabState, olderMessages: Message[], allMessages: Message[]): Promise<void> {
		let end = olderMessages.length
		while (end > 0) {
			const chunkSize = Math.max(1, clientConfig.startupBackgroundChunkMessages)
			const start = Math.max(0, end - chunkSize)
			const chunk = olderMessages.slice(start, end)
			const chunkBlocks = await replay.replayToBlocks(tab.sessionId, chunk, tab.info.model, true, {
				toolResultSourceMessages: allMessages,
				appendInterruptedHint: false,
			})
			if (chunkBlocks.length > 0) tab.blocks.unshift(...chunkBlocks)
			end = start
			this.onUpdate()
			await Bun.sleep(0)
		}
	}

	private async hydrateOlderHistoryInWorker(tab: TabState, olderMessages: Message[], allMessages: Message[]): Promise<void> {
		const worker = new Worker(new URL('./session/replay-worker.ts', import.meta.url).href, { type: 'module' })
		const requestId = randomBytes(8).toString('hex')
		try {
			await new Promise<void>((resolve, reject) => {
				let done = false
				const finish = (fn: () => void) => {
					if (done) return
					done = true
					fn()
				}
				worker.onmessage = (event: any) => {
					const msg = event?.data as any
					if (!msg || msg.requestId !== requestId) return
					if (msg.type === 'chunk') {
						const chunkBlocks = Array.isArray(msg.blocks) ? msg.blocks : []
						if (chunkBlocks.length > 0) tab.blocks.unshift(...chunkBlocks)
						this.onUpdate()
						return
					}
					if (msg.type === 'done') {
						finish(resolve)
						return
					}
					if (msg.type === 'error') {
						finish(() => reject(new Error(typeof msg.message === 'string' ? msg.message : 'history worker failed')))
					}
				}
				worker.onerror = (event: any) => {
					finish(() => reject(new Error(event?.message || 'history worker failed')))
				}
				worker.postMessage({
					type: 'hydrate-older',
					requestId,
					sessionId: tab.sessionId,
					model: tab.info.model,
					olderMessages,
					allMessages,
					chunkSize: Math.max(1, clientConfig.startupBackgroundChunkMessages),
				})
			})
		} finally {
			worker.terminate()
		}
	}

	private hydrateOlderHistoryInBackground(tab: TabState, olderMessages: Message[], allMessages: Message[]): void {
		if (olderMessages.length === 0) return
		if (this.startupBackgroundHydration.has(tab.sessionId)) return
		tab.loadingHistory = true
		const sessionId = tab.sessionId
		const task = (async () => {
			if (clientConfig.startupUseWorkerForHistory && typeof Worker !== 'undefined') {
				try {
					await this.hydrateOlderHistoryInWorker(tab, olderMessages, allMessages)
					return
				} catch {}
			}
			await this.hydrateOlderHistoryInProcess(tab, olderMessages, allMessages)
		})()
		this.startupBackgroundHydration.set(sessionId, task)
		void task.finally(() => {
			this.startupBackgroundHydration.delete(sessionId)
			tab.loadingHistory = false
			this.onUpdate()
		})
	}

	private async hydrateTab(tab: TabState, opts?: { progressiveStartup?: boolean }): Promise<number> {
		const startedAt = Date.now()
		const inputDraftPromise = draft.loadDraft(tab.sessionId)
		const hydration = await this.loadHydrationPayload(tab.sessionId)
		const replayMessages = hydration.replayMessages
		const shouldProgressive = !!opts?.progressiveStartup && replayMessages.length >= clientConfig.startupProgressiveMinMessages
		if (shouldProgressive) {
			const tailCount = Math.max(1, clientConfig.startupTailMessageCount)
			const tailStart = Math.max(0, replayMessages.length - tailCount)
			const olderMessages = replayMessages.slice(0, tailStart)
			const tailMessages = replayMessages.slice(tailStart)
			const tailBlocks = await replay.replayToBlocks(tab.sessionId, tailMessages, tab.info.model, tab.busy, {
				toolResultSourceMessages: replayMessages,
			})
			tab.blocks.push(...tailBlocks)
			this.hydrateOlderHistoryInBackground(tab, olderMessages, replayMessages)
		} else {
			const blocks = await replay.replayToBlocks(tab.sessionId, replayMessages, tab.info.model, tab.busy)
			tab.blocks.push(...blocks)
			tab.loadingHistory = false
		}
		tab.inputHistory = hydration.inputHistory
		tab.inputDraft = await inputDraftPromise
		return Date.now() - startedAt
	}

	async start(): Promise<void> {
		const { state: rtState, sessions } = await this.transport.bootstrap()
		for (const info of sessions) {
			const pendingQuestion = rtState.pendingQuestions?.[info.id]
			this.state.tabs.push({
				sessionId: info.id,
				blocks: [],
				info,
				busy: rtState.busySessionIds.includes(info.id),
				pausing: false,
				inputHistory: [],
				inputDraft: '',
				contentHeight: 0,
				context: info.context,
				loadingHistory: false,
				question: pendingQuestion ? { id: pendingQuestion.id, text: pendingQuestion.text } : undefined,
			})
		}
		// Prefer client's last-viewed tab, fall back to server's active session
		const lastTab = clientState.getLastTab()
		const preferredId = lastTab ?? rtState.activeSessionId
		const preferredIdx = this.state.tabs.findIndex(t => t.sessionId === preferredId)
		this.state.activeTabIndex = Math.max(0, preferredIdx)
		const restoredLastTab = !!lastTab && preferredIdx >= 0
		if (!restoredLastTab) {
			if (selfModeEnabled()) {
				this.applySelfMode()
			} else {
				const cwdTarget = cwdModeTarget()
				if (cwdTarget) this.applyCwdMode(cwdTarget)
			}
		}
		this.state.connected = true
		this.pendingStartupPerf = startupPerfSample()
		this.onUpdate()

		const offset = await this.transport.eventsOffset()

		const activeBeforeHydration = this.activeTab()
		if (activeBeforeHydration) {
			const activeHydrateMs = await this.hydrateTab(activeBeforeHydration, { progressiveStartup: true })
			this.applyTabToPrompt(activeBeforeHydration)
			clientState.saveLastTab(activeBeforeHydration.sessionId)
			this.renderAndCaptureStartup(activeHydrateMs)
		}
		for (const tab of this.state.tabs) {
			if (tab === activeBeforeHydration) continue
			await this.hydrateTab(tab)
		}

		for await (const event of this.transport.tailEvents(offset).items) {
			this.handleEvent(event)
			this.onUpdate()
		}
	}

	private handleEvent(event: RuntimeEvent): void {
		const tab = (sid: string | null) => sid ? this.state.tabs.find(t => t.sessionId === sid) ?? null : this.activeTab()
		const lastBlock = (t: TabState) => t.blocks[t.blocks.length - 1]
		const closeStreaming = (t: TabState) => {
			const b = lastBlock(t)
			if (b && (b.type === 'assistant' || b.type === 'thinking') && !b.done) b.done = true
		}

		switch (event.type) {
			case 'chunk': {
				const t = tab(event.sessionId); if (!t) return
				const last = lastBlock(t)
				if (event.channel === 'thinking') {
					if (last?.type === 'thinking' && !last.done) last.text += event.text
					else t.blocks.push({ type: 'thinking', text: event.text, done: false, blobId: event.blobId, model: t.info.model, sessionId: t.sessionId })
				} else {
					if (last?.type === 'assistant' && !last.done) last.text += event.text
					else {
						if (last?.type === 'thinking' && !last.done) last.done = true
						t.blocks.push({ type: 'assistant', text: event.text, done: false, model: t.info.model })
					}
				}
				break
			}
			case 'line': {
				if (event.text === '[host-released]') {
					const fn = (globalThis as any).__halTryPromote
					if (typeof fn === 'function') fn()
					return
				}
				const t = tab(event.sessionId); if (!t) return
				if (event.text === '[paused]' && t.pausing) {
					t.pausing = false
					const idx = t.blocks.findIndex(b => b.type === 'info' && b.text === '[pausing...]')
					if (idx >= 0) t.blocks.splice(idx, 1)
				}
				if (event.level === 'error') {
					t.blocks.push({ type: 'error', text: event.text, detail: event.detail })
				} else {
					t.blocks.push({ type: 'info', text: event.text })
				}
				break
			}
			case 'prompt': {
				const t = tab(event.sessionId); if (!t) return
				t.blocks.push({ type: 'input', text: event.text, model: t.info.model })
				break
			}
			case 'status': {
				const busy = new Set(event.busySessionIds ?? [])
				const active = this.activeTab()
				for (const t of this.state.tabs) {
					const wasBusy = t.busy
					t.busy = busy.has(t.sessionId)
					if (t.busy) {
						t.blocks = t.blocks.filter((b) => {
							if (b.type !== 'info') return true
							if (b.text === '[interrupted] Type /continue to continue') return false
							return !b.text.endsWith('. Press Enter to continue')
						})
					}
					if (!t.busy) {
						t.pausing = false
						if (t.question) {
							t.question = undefined
							if (t === active && prompt.hasQuestion()) prompt.clearQuestion()
						}
					}
					if (wasBusy && !t.busy && t !== active) t.doneUnseen = true
					if (event.contexts?.[t.sessionId]) t.context = event.contexts[t.sessionId]
				}
				break
			}
			case 'sessions': {
				this.syncTabs(event.sessions)
				break
			}
			case 'tool': {
				if (!event.sessionId) return
				const t = tab(event.sessionId); if (!t) return
				closeStreaming(t)
				if (event.phase === 'running') {
					t.blocks.push({ type: 'tool', toolId: event.toolId, name: event.name, args: event.args, output: '', status: 'running', startTime: Date.now(), blobId: event.blobId, sessionId: event.sessionId })
				} else if (event.phase === 'streaming') {
					for (let i = t.blocks.length - 1; i >= 0; i--) {
						const b = t.blocks[i]
						if (b.type === 'tool' && b.toolId === event.toolId && b.status === 'running') {
							b.output += event.output ?? ''
							break
						}
					}
				} else {
					for (let i = t.blocks.length - 1; i >= 0; i--) {
						const b = t.blocks[i]
						if (b.type === 'tool' && b.toolId === event.toolId && b.status === 'running') {
							b.status = event.phase === 'error' ? 'error' : 'done'
							b.output = event.output ?? ''
							b.endTime = Date.now()
							if (event.blobId) b.blobId = event.blobId
							break
						}
					}
				}
				break
			}
			case 'command': {
				if (event.phase === 'done' || event.phase === 'failed') {
					const t = tab(event.sessionId); if (t) closeStreaming(t)
				}
				break
			}
			case 'question': {
				const t = tab(event.sessionId); if (!t) return
				t.question = { id: event.questionId, text: event.text }
				if (t === this.activeTab()) prompt.setQuestion(event.text)
				break
			}
			case 'answer': {
				const t = tab(event.sessionId); if (!t) return
				closeStreaming(t)
				t.question = undefined
				if (t === this.activeTab() && prompt.hasQuestion()) prompt.clearQuestion()
				t.blocks.push({ type: 'input', text: event.question, source: 'Hal asked' })
				t.blocks.push({ type: 'input', text: event.text || '[no answer]', source: 'You replied' })
				break
			}
		}
	}

	private async syncTabs(sessions: SessionInfo[]): Promise<void> {
		const current = new Map(this.state.tabs.map(t => [t.sessionId, t]))
		const newTabs: TabState[] = []
		let newTabId: string | null = null
		for (const info of sessions) {
			const existing = current.get(info.id)
			if (existing) { existing.info = info; existing.context = info.context ?? existing.context; newTabs.push(existing) }
			else { newTabs.push({ sessionId: info.id, blocks: [], info, busy: false, pausing: false, inputHistory: [], inputDraft: '', contentHeight: 0, context: info.context, loadingHistory: false }); newTabId = info.id }
		}
		const prevId = this.state.tabs[this.state.activeTabIndex]?.sessionId
		this.state.tabs = newTabs
		if (newTabId && this.pendingOpen) {
			this.pendingOpen = false
			const idx = newTabs.findIndex(t => t.sessionId === newTabId)
			if (idx >= 0) this.state.activeTabIndex = idx
		} else {
			const kept = newTabs.findIndex(t => t.sessionId === prevId)
			if (kept >= 0) {
				this.state.activeTabIndex = kept
			} else {
				// Tab was closed — stay at same index (tab to the right slides in)
				const prevIdx = this.state.activeTabIndex
				this.state.activeTabIndex = Math.min(prevIdx, newTabs.length - 1)
			}
		}
		const hydrateMsBySession = new Map<string, number>()
		for (const tab of newTabs) {
			if (!current.has(tab.sessionId)) {
				const hydrateMs = await this.hydrateTab(tab)
				hydrateMsBySession.set(tab.sessionId, hydrateMs)
			}
		}
		const newId = this.state.tabs[this.state.activeTabIndex]?.sessionId
		if (newId !== prevId) this.switchToActiveTab()
		const active = this.activeTab()
		if (active && this.pendingStartupPerf && this.pendingStartupPerf.tabMs === null) {
			const hydrateMs = hydrateMsBySession.get(active.sessionId) ?? null
			this.renderAndCaptureStartup(hydrateMs)
			return
		}
		this.appendStartupPerfIfPossible()
		this.onUpdate()
	}

	private applyTabToPrompt(tab: TabState): void {
		prompt.setHistory(tab.inputHistory)
		if (tab.inputDraft) prompt.setText(tab.inputDraft)
		if (tab.question) prompt.setQuestion(tab.question.text)
	}

	saveDraft(): void {
		const tab = this.activeTab()
		if (!tab) return
		if (prompt.hasQuestion()) return // don't overwrite draft with answer text
		tab.inputDraft = prompt.text()
		draft.saveDraft(tab.sessionId, tab.inputDraft).catch(() => {})
	}

	saveDraftSync(): void {
		const tab = this.activeTab()
		if (!tab) return
		if (prompt.hasQuestion()) return // don't overwrite draft with answer text
		tab.inputDraft = prompt.text()
		try { draft.saveDraftSync(tab.sessionId, tab.inputDraft) } catch {}
	}

	clearQuestion(): void {
		const tab = this.activeTab()
		if (tab) tab.question = undefined
	}

	onSubmit(): void {
		const tab = this.activeTab()
		if (!tab) return
		// History push happens in prompt.pushHistory (shared array via setHistory)
		tab.inputDraft = ''
		draft.saveDraft(tab.sessionId, '').catch(() => {})
	}

	async send(type: CommandType, text?: string): Promise<void> {
		if (type === 'open' || type === 'fork' || (type === 'resume' && text)) this.pendingOpen = true
		const tab = this.activeTab()
		const sessionId = tab?.sessionId
		if (!sessionId && type !== 'open') throw new Error('no active session')
		await this.transport.sendCommand(protocol.makeCommand(type, this.source, text, sessionId))
	}

	markPausing(): void {
		const tab = this.activeTab()
		if (!tab || !tab.busy) return
		tab.pausing = true
		tab.blocks.push({ type: 'info', text: '[pausing...]' })
	}
	nextTab(): void {
		if (this.state.tabs.length <= 1) return
		this.saveDraft()
		this.state.activeTabIndex = (this.state.activeTabIndex + 1) % this.state.tabs.length
		this.switchToActiveTab()
	}

	prevTab(): void {
		if (this.state.tabs.length <= 1) return
		this.saveDraft()
		const len = this.state.tabs.length
		this.state.activeTabIndex = (this.state.activeTabIndex - 1 + len) % len
		this.switchToActiveTab()
	}

	switchToTab(idx: number): void {
		if (idx < 0 || idx >= this.state.tabs.length || idx === this.state.activeTabIndex) return
		this.saveDraft()
		this.state.activeTabIndex = idx
		this.switchToActiveTab()
	}

	private switchToActiveTab(): void {
		prompt.reset()
		const tab = this.activeTab()
		if (tab) {
			tab.doneUnseen = false
			this.applyTabToPrompt(tab)
			clientState.saveLastTab(tab.sessionId)
		}
	}
}
