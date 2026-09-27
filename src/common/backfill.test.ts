import { expect, test } from 'bun:test'
import { backfill, type Backfill } from './backfill.ts'
import type { Event, Snapshot } from './protocol.ts'
import type { HistoryRecord } from './replay.ts'
import { transcript, type Transcript } from './transcript.ts'

const ts = '2026-09-26T00:00:01Z'
const meta = { id: 's', cwd: '/', model: 'fake/m', createdAt: ts }
const prompt = (text: string): HistoryRecord => ({ type: 'user', blocks: [{ type: 'text', text }], ts })
const output = (text: string): HistoryRecord => ({ type: 'output', text, ts })
const asked: HistoryRecord = { type: 'question', id: 'q', form: { text: 'Ok?', fields: [{ type: 'text', name: 'x' }] }, ts }
const shown = (t: Transcript) => t.items.map((i) => ('text' in i ? i.text : i.type))

// A prompt, an open question, then commands' output: the snapshot's
// tail holds only the last outputs, and pages go back two records at a
// time.
// numbered as the host numbers them.
const all = [prompt('p1'), { type: 'turn_end', status: 'completed', usage: {}, ts } as HistoryRecord, prompt('p2'), asked, output('o1'), output('o2'), output('o3'), output('o4')].map((r, i) => ({ ...r, n: i + 1 }))
const question = all[3]!

function start(): { sessions: Map<string, Backfill>; t: Transcript } {
	let snapshot: Snapshot = { meta, history: all.slice(6), state: { type: 'blocked', reason: 'question' }, older: 6, earlier: [all[2]!, question] }
	let sessions = new Map<string, Backfill>()
	let event = { type: 'snapshot', sessionId: 's', snapshot } as Event & { type: 'snapshot' }
	backfill.onSnapshot(sessions, event)
	return { sessions, t: transcript.fromSnapshot(snapshot) }
}

function page(sessions: Map<string, Backfill>, t: Transcript): Transcript {
	let asked = backfill.next(sessions, 's')!
	let from = asked.before
	let records = all.slice(Math.max(0, from - 2), from)
	let event = { type: 'history', sessionId: 's', before: from, records, ...(from > 2 ? { older: from - 2 } : {}) } as Event & { type: 'history' }
	expect(backfill.onPage(sessions, event)).toBe(true)
	return backfill.apply(sessions, t)
}

test('the open question and its prompt stand in on top until the page holding them arrives', () => {
	let { sessions, t } = start()
	expect(shown(t)).toEqual(['p2', 'question', 'o3', 'o4'])
	expect(transcript.question(t)?.id).toBe('q')
	let before = t.items
	t = page(sessions, t)
	expect(shown(t)).toEqual(['p2', 'question', 'o1', 'o2', 'o3', 'o4'])
	// Every item shown before keeps its key, stand-ins included, so the
	// web keeps its row.
	for (let item of before) expect(t.items.find((i) => i.key === item.key)).toEqual(item)
	t = page(sessions, t)
	expect(shown(t)).toEqual(['p2', 'question', 'o1', 'o2', 'o3', 'o4'])
	expect(t.earlier).toBeUndefined()
	t = page(sessions, t)
	expect(t).toEqual(transcript.fromSnapshot({ meta, history: all, state: t.state }))
	expect(backfill.complete(sessions, 's')).toBe(true)
})

test('a stand-in answered meanwhile stays answered once the real history is in', () => {
	let { sessions, t } = start()
	t = transcript.fold(t, { type: 'answer', sessionId: 's', question: 'q', answers: { x: 'yes' } })!
	t = transcript.fold(t, { type: 'state', sessionId: 's', state: { type: 'idle' } })!
	for (let i = 0; i < 3; i++) t = page(sessions, t)
	let answered = [...all, { type: 'answer', question: 'q', answers: { x: 'yes' }, ts, n: 9 } as HistoryRecord]
	let full = transcript.fromSnapshot({ meta, history: answered, state: { type: 'idle' } })
	expect(t.items).toEqual(full.items)
	expect(t.prompt).toBe(full.prompt)
})

test('the terminal asks page after page and shows them all at once', () => {
	let { sessions, t } = start()
	let view = { transcript: t, resumed: { at: t.items.length } }
	let first = backfill.fetchAll(sessions, view, { type: 'snapshot', sessionId: 's', snapshot: { meta, history: all.slice(6), state: t.state, older: 6, earlier: [all[2]!, question] } })
	let asked = first.command!
	for (let n = 0; ; n++) {
		let from = asked.before
		let out = backfill.fetchAll(sessions, view, { type: 'history', sessionId: 's', before: from, records: all.slice(Math.max(0, from - 2), from), ...(from > 2 ? { older: from - 2 } : {}) })
		if (out.command) {
			expect(out.view).toBeUndefined()
			asked = out.command
			continue
		}
		expect(n).toBe(2)
		expect(out.view!.transcript).toEqual(transcript.fromSnapshot({ meta, history: all, state: t.state }))
		expect(out.view!.resumed!.at).toBe(all.length)
		break
	}
})
