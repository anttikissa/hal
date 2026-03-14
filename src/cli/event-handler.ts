// Event dispatch — maps runtime events to tab block mutations.

import type { RuntimeEvent } from '../protocol.ts'
import type { TabState, ClientState } from './tabs.ts'
import { prompt } from './prompt.ts'
import { draft } from './draft.ts'

function handleEvent(event: RuntimeEvent, state: ClientState): void {
	const active = () => state.tabs[state.activeTabIndex] ?? null
	const tab = (sid: string | null) => sid ? state.tabs.find(t => t.sessionId === sid) ?? null : active()
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
				else t.blocks.push({ type: 'thinking', text: event.text, done: false, blobId: event.blobId, model: t.info.model, sessionId: t.sessionId, ts: Date.parse(event.createdAt) })
			} else {
				if (last?.type === 'assistant' && !last.done) last.text += event.text
				else {
					if (last?.type === 'thinking' && !last.done) last.done = true
					t.blocks.push({ type: 'assistant', text: event.text, done: false, model: t.info.model, ts: Date.parse(event.createdAt) })
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
				t.blocks.push({ type: 'error', text: event.text, detail: event.detail, ts: Date.parse(event.createdAt) })
			} else {
				t.blocks.push({ type: 'info', text: event.text, ts: Date.parse(event.createdAt) })
			}
			break
		}
		case 'prompt': {
			const t = tab(event.sessionId); if (!t) return
			const status = event.label === 'steering' ? 'steering' as const : undefined
			t.blocks.push({ type: 'input', text: event.text, model: t.info.model, status, ts: Date.parse(event.createdAt) })
			break
		}
		case 'status': {
			const busy = new Set(event.busySessionIds ?? [])
			const a = active()
			for (const t of state.tabs) {
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
						if (t === a && prompt.hasQuestion()) prompt.clearQuestion()
					}
				}
				if (wasBusy && !t.busy && t !== a) t.doneUnseen = true
				if (event.contexts?.[t.sessionId]) t.context = event.contexts[t.sessionId]
			}
			break
		}
		case 'tool': {
			if (!event.sessionId) return
			const t = tab(event.sessionId); if (!t) return
			closeStreaming(t)
			if (event.phase === 'running') {
				t.blocks.push({ type: 'tool', toolId: event.toolId, name: event.name, args: event.args, output: '', status: 'running', startTime: Date.now(), blobId: event.blobId, sessionId: event.sessionId, ts: Date.parse(event.createdAt) })
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
			if (t === active()) prompt.setQuestion(event.text)
			break
		}
		case 'answer': {
			const t = tab(event.sessionId); if (!t) return
			closeStreaming(t)
			t.question = undefined
			if (t === active() && prompt.hasQuestion()) prompt.clearQuestion()
			const answerTs = Date.parse(event.createdAt)
			t.blocks.push({ type: 'input', text: event.question, source: 'Hal asked', ts: answerTs })
			t.blocks.push({ type: 'input', text: event.text || '[no answer]', source: 'You replied', ts: answerTs })
			break
		}
		case 'draft_saved': {
			const a = active()
			if (a?.sessionId === event.sessionId && !prompt.text()) {
				void draft.loadDraft(event.sessionId).then(text => {
					if (text && !prompt.text()) prompt.setText(text)
				})
			}
			break
		}
	}
}

export const eventHandler = { handleEvent }
