// Client — connects transport to TUI blocks.

import type { Transport } from './transport.ts'
import type { Block } from './blocks.ts'
import type { CommandType, RuntimeEvent, RuntimeSource, SessionInfo } from '../protocol.ts'
import { makeCommand } from '../protocol.ts'
import { replayToBlocks } from '../session/replay.ts'
import { loadInputHistory, saveDraft, loadDraft } from '../session/messages.ts'
import * as prompt from './prompt.ts'
import { randomBytes } from 'crypto'

export interface TabState {
	sessionId: string
	blocks: Block[]
	info: SessionInfo
	busy: boolean
	inputHistory: string[]
	inputDraft: string
	contentHeight: number
	question?: { id: string; text: string }
}

export interface ClientState {
	tabs: TabState[]
	activeTabIndex: number
	connected: boolean
}

export class Client {
	private transport: Transport
	private source: RuntimeSource
	private state: ClientState
	private onUpdate: () => void
	private pendingOpen = false

	constructor(transport: Transport, onUpdate: () => void) {
		this.transport = transport
		this.source = { kind: 'cli', clientId: randomBytes(4).toString('hex') }
		this.state = { tabs: [], activeTabIndex: 0, connected: false }
		this.onUpdate = onUpdate
	}

	getState(): ClientState { return this.state }
	activeTab(): TabState | null { return this.state.tabs[this.state.activeTabIndex] ?? null }

	async start(): Promise<void> {
		const { state: rtState, sessions } = await this.transport.bootstrap()
		for (const info of sessions) {
			this.state.tabs.push({ sessionId: info.id, blocks: [], info, busy: rtState.busySessionIds.includes(info.id), inputHistory: [], inputDraft: '', contentHeight: 0 })
		}
		this.state.activeTabIndex = Math.max(0, this.state.tabs.findIndex(t => t.sessionId === rtState.activeSessionId))
		this.state.connected = true
		this.onUpdate()

		const offset = await this.transport.eventsOffset()

		for (const tab of this.state.tabs) {
			const messages = await this.transport.replaySession(tab.sessionId)
			tab.blocks.push(...await replayToBlocks(tab.sessionId, messages, tab.info.model))
			tab.inputHistory = await loadInputHistory(tab.sessionId)
			tab.inputDraft = await loadDraft(tab.sessionId)
		}
		const active = this.activeTab()
		if (active) this.applyTabToPrompt(active)
		this.onUpdate()

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
					else t.blocks.push({ type: 'thinking', text: event.text, done: false })
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
				const prefix = event.level === 'error' ? '⚠ ' : ''
				t.blocks.push({ type: 'info', text: `${prefix}${event.text}` })
				break
			}
			case 'prompt': {
				const t = tab(event.sessionId); if (!t) return
				t.blocks.push({ type: 'input', text: event.text, model: t.info.model })
				break
			}
			case 'status': {
				const busy = new Set(event.busySessionIds ?? [])
				for (const t of this.state.tabs) t.busy = busy.has(t.sessionId)
				break
			}
			case 'sessions': {
				this.syncTabs(event.sessions)
				break
			}
			case 'tool': {
				const t = tab(event.sessionId); if (!t) return
				closeStreaming(t)
				if (event.phase === 'running') {
					t.blocks.push({ type: 'tool', name: event.name, args: event.args, output: '', status: 'running', startTime: Date.now() })
				} else if (event.phase === 'streaming') {
					for (let i = t.blocks.length - 1; i >= 0; i--) {
						const b = t.blocks[i]
						if (b.type === 'tool' && b.status === 'running') {
							b.output += event.output ?? ''
							break
						}
					}
				} else {
					for (let i = t.blocks.length - 1; i >= 0; i--) {
						const b = t.blocks[i]
						if (b.type === 'tool' && b.name === event.name && b.status === 'running') {
							b.status = event.phase === 'error' ? 'error' : 'done'
							b.output = event.output ?? ''
							b.endTime = Date.now()
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
		}
	}

	private syncTabs(sessions: SessionInfo[]): void {
		const current = new Map(this.state.tabs.map(t => [t.sessionId, t]))
		const newTabs: TabState[] = []
		let newTabId: string | null = null
		for (const info of sessions) {
			const existing = current.get(info.id)
			if (existing) { existing.info = info; newTabs.push(existing) }
			else { newTabs.push({ sessionId: info.id, blocks: [], info, busy: false, inputHistory: [], inputDraft: '', contentHeight: 0 }); newTabId = info.id }
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
		const newId = this.state.tabs[this.state.activeTabIndex]?.sessionId
		if (newId !== prevId) this.switchToActiveTab()
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
		saveDraft(tab.sessionId, tab.inputDraft).catch(() => {})
	}

	clearQuestion(): void {
		const tab = this.activeTab()
		if (tab) tab.question = undefined
	}

	onSubmit(text: string): void {
		const tab = this.activeTab()
		if (!tab) return
		tab.inputHistory.push(text)
		tab.inputDraft = ''
		saveDraft(tab.sessionId, '').catch(() => {})
	}

	async send(type: CommandType, text?: string): Promise<void> {
		if (type === 'open') this.pendingOpen = true
		const tab = this.activeTab()
		const sessionId = tab?.sessionId
		if (!sessionId && type !== 'open') throw new Error('no active session')
		await this.transport.sendCommand(makeCommand(type, this.source, text, sessionId))
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
		if (tab) this.applyTabToPrompt(tab)
	}
}
