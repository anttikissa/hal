// Client — connects transport to TUI blocks.

import type { Transport } from './cli/transport.ts'
import type { CommandType, RuntimeSource } from './protocol.ts'
import { protocol } from './protocol.ts'
import { clientState } from './client-state.ts'
import { randomBytes } from 'crypto'
import { resolve } from 'path'
import { startupClientPerf, type StartupPerfHolder } from './perf/startup-client-perf.ts'
import { eventHandler } from './cli/event-handler.ts'
import { tabs, clientConfig, type TabState, type ClientState } from './cli/tabs.ts'

export type { TabState, ClientState }
export { clientConfig }

function selfModeEnabled(): boolean { return process.env.HAL_SELF_MODE === '1' }

function cwdModeTarget(): string | null {
	if (selfModeEnabled()) return null
	const cwd = process.env.LAUNCH_CWD
	if (!cwd) return null
	const halDir = process.env.HAL_DIR ?? resolve(import.meta.dir, '..')
	if (resolve(cwd) === resolve(halDir)) return null
	return resolve(cwd)
}

export class Client {
	transport: Transport
	private source: RuntimeSource
	state: ClientState
	onUpdate: () => void
	pendingOpen = false
	startupPerf: StartupPerfHolder = { state: null }

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
			tabs.switchToActiveTab(this)
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
			tabs.switchToActiveTab(this)
			return
		}
		if (!this.pendingOpen) {
			this.pendingOpen = true
			const cmd = protocol.makeCommand('open', this.source, undefined, undefined)
			cmd.workingDir = target
			void this.transport.sendCommand(cmd)
		}
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
				hydrated: false,
			})
		}
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
		this.startupPerf = { state: startupClientPerf.sample() }
		this.onUpdate()

		const offset = await this.transport.eventsOffset()

		const activeBeforeHydration = this.activeTab()
		if (activeBeforeHydration) {
			const activeHydration = await tabs.hydrateTab(this, activeBeforeHydration, { progressiveStartup: true, startupTrace: true })
			tabs.applyTabToPrompt(activeBeforeHydration)
			clientState.saveLastTab(activeBeforeHydration.sessionId)
			startupClientPerf.renderAndCapture(this.startupPerf, activeBeforeHydration.blocks, activeBeforeHydration.sessionId, this.onUpdate, activeHydration)
		}
		const nonActiveHydration = tabs.hydrateNonActiveTabs(this, activeBeforeHydration?.sessionId ?? null)
		const eventTail = this.transport.tailEvents(offset)
		for await (const event of eventTail.items) {
			if (event.type === 'sessions') {
				void tabs.syncTabs(this, event.sessions)
			} else {
				eventHandler.handleEvent(event, this.state)
			}
			this.onUpdate()
		}
		await nonActiveHydration
	}

	nextTab(): void { tabs.nextTab(this) }
	prevTab(): void { tabs.prevTab(this) }
	switchToTab(idx: number): void { tabs.switchToTab(this, idx) }
	saveDraft(): Promise<void> { return tabs.saveDraft(this) }
	onSubmit(): void { tabs.onSubmitTab(this) }
	clearQuestion(): void { tabs.clearQuestion(this) }
	markPausing(): void { tabs.markPausing(this) }

	async send(type: CommandType, text?: string): Promise<void> {
		if (type === 'open' || type === 'fork' || (type === 'resume' && text)) this.pendingOpen = true
		const tab = this.activeTab()
		const sessionId = tab?.sessionId
		if (!sessionId && type !== 'open') throw new Error('no active session')
		await this.transport.sendCommand(protocol.makeCommand(type, this.source, text, sessionId))
	}
}
