// The browser client's state, without the DOM: the transcript folded
// from host events (the same transcript.fold the terminal uses), a
// passing notice, and what each item looks like as text. page.ts feeds
// it the events from link.ts and draws it.

import type { Event } from '../common/protocol.ts'
import { transcript, type Item, type Transcript } from '../common/transcript.ts'

export type ViewState = { transcript?: Transcript; notice?: string }

// One transcript item as shown: a CSS class and its text. Null shows
// nothing (a completed turn end).
export type Shown = { kind: string; text: string } | null

function onEvent(st: ViewState, event: Event): ViewState {
	if (event.type === 'rejected') return { ...st, notice: `${event.command} refused: ${event.reason}` }
	let t = transcript.fold(st.transcript, event)
	return t === st.transcript ? st : { ...st, transcript: t }
}

// What a submit of `text` does: send a command, or show why not (the
// typed text stays). Empty text does nothing.
function submit(st: ViewState, text: string): { command?: unknown; notice?: string; keep: boolean } {
	if (!text.trim()) return { keep: false }
	if (!st.transcript) return { notice: 'no session yet', keep: true }
	if (st.transcript.live) return { notice: 'a turn is running; Escape cancels it', keep: true }
	return { command: { type: 'submit', sessionId: st.transcript.meta.id, text }, keep: false }
}

// The cancel command for Escape, if a turn is running.
function cancel(st: ViewState): unknown {
	return st.transcript?.live ? { type: 'cancel', sessionId: st.transcript.meta.id } : undefined
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, ' ').trim()
}

function show(item: Item): Shown {
	switch (item.type) {
		case 'prompt':
			return { kind: 'prompt', text: item.text }
		case 'text':
		case 'thinking':
			return { kind: item.type, text: item.text }
		case 'tool': {
			let { command, description } = item.input
			if (typeof command === 'string' && typeof description === 'string')
				return { kind: 'tool', text: `▸ ${oneLine(description)}\n  $ ${command}` }
			return { kind: 'tool', text: `▸ ${item.name} ${JSON.stringify(item.input)}` }
		}
		case 'tool-result': {
			// A glimpse, like the terminal: the model sees all of it.
			let rows = item.output.replace(/\n$/, '').split('\n')
			let shown = rows.slice(0, view.resultRows())
			if (rows.length > shown.length) shown.push(`… ${rows.length - shown.length} more lines`)
			return { kind: item.isError ? 'result error' : 'result', text: (item.isError ? '✗ ' : '◂ ') + shown.join('\n  ') }
		}
		case 'turn-end':
			if (item.status === 'error') return { kind: 'end error', text: `error: ${item.error ?? 'turn failed'}` }
			if (item.status === 'completed') return null
			return { kind: 'end', text: `[${item.status}]` }
	}
}

export const view = {
	// Rows of a tool result shown in the transcript.
	resultRows: () => 8,
	onEvent,
	submit,
	cancel,
	show,
}
