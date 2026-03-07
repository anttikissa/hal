// Client — connects transport to TUI blocks.
// Handles bootstrap, event tailing, and block translation.

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

	constructor(transport: Transport, onUpdate: () => void) {
		this.transport = transport
		this.source = { kind: 'cli', clientId: randomBytes(4).toString('hex') }
		this.state = { tabs: [], activeTabIndex: 0, connected: false }
		this.onUpdate = onUpdate
	}

	getState(): ClientState { return this.state }

	activeTab(): TabState | null {
		return this.state.tabs[this.state.activeTabIndex] ?? null
	}

	// ── Bootstrap + event loop ──

	async start(): Promise<void> {
		const { state: rtState, sessions } = await this.transport.bootstrap()

		// Create tabs from sessions
		for (const info of sessions) {
			this.state.tabs.push({
				sessionId: info.id,
				blocks: [],
				info,
				busy: rtState.busySessionIds.includes(info.id),
				inputHistory: [],
				inputDraft: '',
			})
		}

		// Set active tab
		const activeIdx = this.state.tabs.findIndex(t => t.sessionId === rtState.activeSessionId)
		this.state.activeTabIndex = Math.max(0, activeIdx)
		this.state.connected = true
		this.onUpdate()

		// Replay history + load input history/drafts for each tab
		for (const tab of this.state.tabs) {
			await this.replayHistory(tab)
			tab.inputHistory = await loadInputHistory(tab.sessionId)
			tab.inputDraft = await loadDraft(tab.sessionId)
		}

		// Apply active tab's history/draft to prompt
		const active = this.activeTab()
		if (active) this.applyTabToPrompt(active)
		this.onUpdate()

		// Tail events from current offset (gap-free: we read state, now tail from there)
		const offset = await this.transport.eventsOffset()
		this.tailEvents(offset)
	}

	private async replayHistory(tab: TabState): Promise<void> {
		const messages = await this.transport.replaySession(tab.sessionId)
		tab.blocks.push(...replayToBlocks(messages, tab.info.model))
	}

	private async tailEvents(fromOffset: number): Promise<void> {
		const { items } = this.transport.tailEvents(fromOffset)
		for await (const event of items) {
			this.handleEvent(event)
			this.onUpdate()
		}
	}

	// ── Event handling ──

	private findTab(sessionId: string | null): TabState | null {
		if (!sessionId) return this.activeTab()
		return this.state.tabs.find(t => t.sessionId === sessionId) ?? null
	}

	private handleEvent(event: RuntimeEvent): void {
		switch (event.type) {
			case 'chunk': {
				const tab = this.findTab(event.sessionId)
				if (!tab) return
				this.appendChunk(tab, event.channel, event.text)
				break
			}
			case 'line': {
				// Fast-path host promotion
				if (event.text === '[host-released]') {
					const tryPromote = (globalThis as any).__halTryPromote
					if (typeof tryPromote === 'function') tryPromote()
					return
				}
				const tab = this.findTab(event.sessionId)
				if (!tab) return
				if (event.level === 'meta' || event.level === 'notice') {
					tab.blocks.push({ type: 'assistant', text: event.text, done: true })
				} else if (event.level === 'error') {
					tab.blocks.push({ type: 'assistant', text: `⚠ ${event.text}`, done: true })
				}
				break
			}
			case 'prompt': {
				const tab = this.findTab(event.sessionId)
				if (!tab) return
				tab.blocks.push({ type: 'input', text: event.text, model: tab.info.model })
				break
			}
			case 'status': {
				const busy = new Set(event.busySessionIds ?? [])
				for (const tab of this.state.tabs) {
					tab.busy = busy.has(tab.sessionId)
				}
				break
			}
			case 'sessions': {
				this.syncTabs(event.sessions, event.activeSessionId)
				break
			}
			case 'tool': {
				const tab = this.findTab(event.sessionId)
				if (!tab) return
				// Close any open streaming block before tool
				const prev = tab.blocks[tab.blocks.length - 1]
				if (prev && (prev.type === 'assistant' || prev.type === 'thinking') && !prev.done) {
					prev.done = true
				}
				if (event.phase === 'running') {
					tab.blocks.push({
						type: 'tool', name: event.name, args: event.args,
						output: '', status: 'running', startTime: Date.now(),
					})
				} else {
					// Find matching tool block and update it
					for (let i = tab.blocks.length - 1; i >= 0; i--) {
						const b = tab.blocks[i]
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
					const tab = this.findTab(event.sessionId)
					if (!tab) return
					// Mark last streaming block as done
					const last = tab.blocks[tab.blocks.length - 1]
					if (last && (last.type === 'assistant' || last.type === 'thinking') && !last.done) {
						last.done = true
					}
				}
				break
			}
		}
	}

	private appendChunk(tab: TabState, channel: 'assistant' | 'thinking', text: string): void {
		const last = tab.blocks[tab.blocks.length - 1]

		if (channel === 'thinking') {
			if (last?.type === 'thinking' && !last.done) {
				last.text += text
			} else {
				tab.blocks.push({ type: 'thinking', text, done: false })
			}
		} else {
			if (last?.type === 'assistant' && !last.done) {
				last.text += text
			} else {
				// Close any open thinking block
				if (last?.type === 'thinking' && !last.done) last.done = true
				tab.blocks.push({ type: 'assistant', text, done: false, model: tab.info.model })
			}
		}
	}

	private syncTabs(sessions: SessionInfo[], activeSessionId: string | null): void {
		const current = new Map(this.state.tabs.map(t => [t.sessionId, t]))
		const newTabs: TabState[] = []

		for (const info of sessions) {
			const existing = current.get(info.id)
			if (existing) {
				existing.info = info
				newTabs.push(existing)
			} else {
				// New tab — don't replay history here; the event tail
				// is already delivering events in real-time.
				newTabs.push({ sessionId: info.id, blocks: [], info, busy: false, inputHistory: [], inputDraft: '' })
			}
		}

		// Preserve current tab if it still exists; only follow server's
		// activeSessionId when our current tab was removed.
		const prevId = this.state.tabs[this.state.activeTabIndex]?.sessionId
		this.state.tabs = newTabs
		const kept = newTabs.findIndex(t => t.sessionId === prevId)
		if (kept >= 0) {
			this.state.activeTabIndex = kept
		} else if (activeSessionId) {
			const idx = newTabs.findIndex(t => t.sessionId === activeSessionId)
			if (idx >= 0) this.state.activeTabIndex = idx
		}
		if (this.state.activeTabIndex >= this.state.tabs.length) {
			this.state.activeTabIndex = Math.max(0, this.state.tabs.length - 1)
		}
	}

	// ── Prompt ↔ Tab state ──

	private applyTabToPrompt(tab: TabState): void {
		prompt.setHistory(tab.inputHistory)
		if (tab.inputDraft) prompt.setText(tab.inputDraft)
	}

	/** Save current prompt text as draft for the active tab. */
	saveDraft(): void {
		const tab = this.activeTab()
		if (!tab) return
		tab.inputDraft = prompt.text()
		saveDraft(tab.sessionId, tab.inputDraft).catch(() => {})
	}

	/** Call after submitting a prompt — pushes to history, clears draft. */
	onSubmit(text: string): void {
		const tab = this.activeTab()
		if (!tab) return
		tab.inputHistory.push(text)
		tab.inputDraft = ''
		saveDraft(tab.sessionId, '').catch(() => {})
	}

	// ── Commands ──

	async send(type: CommandType, text?: string): Promise<void> {
		const tab = this.activeTab()
		const sessionId = tab?.sessionId
		if (!sessionId && type !== 'open') return
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

	private switchToActiveTab(): void {
		prompt.reset()
		const tab = this.activeTab()
		if (tab) this.applyTabToPrompt(tab)
	}
}