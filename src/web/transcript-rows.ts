// Transcript rows for the browser client: each item with its tool result,
// the prompts still pending and the waiting messages after them, and the
// background jobs still running. Transcript.tsx keys cards by them.
// Tasks: dz, w5, rk, 16.

import { bashResult } from '../common/bash-result.ts'
import { inbox, type InboxItem } from '../common/inbox.ts'
import { promptChanges } from '../common/prompt-changes.ts'
import { transcript, type Item } from '../common/transcript.ts'

// A transcript row: an item, and for a tool call its result once it
// came. Rows only grow at the end as items do (a result joins its
// call's row), so rows keyed by position keep their DOM.
// `key`: what keeps the row's card (task w5): the item's key, or for a
// prompt or command this client sent, the command id it had while pending.
// `pending`: sent, not yet acknowledged. `waiting`: in the inbox;
// `note`: a queued message's compact row starts with it (task 16).
// `job`: a running background job's call again, streaming (task 6nn).
export type Row = {
	item: Item
	at: number
	key: string
	result?: Item & { type: 'tool-result' }
	call?: Item & { type: 'tool' }
	pending?: true
	waiting?: true
	note?: string
	job?: true
}

function rows(items: Item[], sent: Record<string, string> = {}, before: Row[] = []): Row[] {
	let out: Row[] = []
	let calls = new Map<string, Row>()
	let keyedCalls = new Map<string, Item & { type: 'tool' }>()
	items = promptChanges.group(items)
	for (let [at, item] of items.entries()) {
		if (item.type === 'turn-end' && item.status === 'completed') continue
		// Thinking with no readable text (redacted or empty) is no card,
		// unless it is the last item, which may be streaming (task hp).
		if (item.type === 'thinking' && !item.text.trim() && at < items.length - 1) continue
		let call = item.type === 'tool-result' ? calls.get(item.id) : undefined
		if (call && item.type === 'tool-result') {
			call.result = item
			continue
		}
		let row: Row = { item, at, key: sent[item.key] ?? item.key }
		let background = bashResult.background(item)
		if (background) row.call = keyedCalls.get(background.replace(/^t/, ''))
		if (item.type === 'tool') {
			calls.set(item.id, row)
			keyedCalls.set(item.key, item)
		}
		out.push(row)
	}
	if (!before.length) return out
	let previous = new Map(before.map((row) => [row.key, row]))
	let next = out.map((row) => {
		let old = previous.get(row.key)
		return old && old.item === row.item && old.result === row.result && old.call === row.call && old.at === row.at
			? old
			: row
	})
	return next.length === before.length && next.every((row, i) => row === before[i]) ? before : next
}

// `rows` and after them the prompts still pending (`id`: the submit's
// command id), but for one the host already put in the transcript: it
// is a row already, under the same key, so its card stays. `tabs`: the
// host's tab ids in order, numbering a queued message's sender. Running
// background jobs come first (task 6nn): their calls again, streaming,
// under `job:<key>` so the transcript's card stays as it was.
function withPending(
	rows: Row[],
	pending: { id: string; text: string; ts?: string }[],
	waiting: InboxItem[] = [],
	tabs: string[] = [],
	held?: string,
	running: Item[] = [],
): Row[] {
	let keys = new Set(rows.map((r) => r.key))
	let at = (rows.at(-1)?.at ?? -1) + 1
	let row = (m: InboxItem): Row => {
		let r: Row = { item: transcript.waitingItem(m), at, key: m.id, waiting: true }
		if (m.delivery === 'after-turn')
			r.note = inbox.note(m, m.from === undefined ? undefined : tabs.indexOf(m.from) + 1 || undefined, m.id === held)
		return r
	}
	let jobs = running.map((item): Row => ({ item, at, key: `job:${item.key}`, job: true }))
	let queued = waiting.filter((m) => !keys.has(m.id)).map(row)
	for (let row of queued) keys.add(row.key)
	let more = pending
		.filter((s) => !keys.has(s.id))
		.map((s): Row => ({ item: { type: 'prompt', text: s.text, ts: s.ts, key: s.id }, at, key: s.id, pending: true }))
	return jobs.length || queued.length || more.length ? [...rows, ...jobs, ...queued, ...more] : rows
}

// Keys of the background Bash calls whose job still runs: started (the
// result says so) and no 'bash t<key>' message has come back. The host
// refuses /kill for one that has just ended.
function jobs(rows: Row[]): ReadonlySet<string> {
	let done = new Set(
		rows.flatMap((r) =>
			r.item.type === 'prompt' && /^bash #?t?\d+$/.test(r.item.label ?? '')
				? [r.item.label!.replace(/^bash #?t?/, '')]
				: [],
		),
	)
	let out = new Set<string>()
	for (let r of rows) {
		let n = r.result?.output.match(/^started in background as #t?(\d+)/)?.[1]
		if (n && !done.has(n)) out.add(n)
	}
	return out
}

export const transcriptRows = { rows, withPending, jobs }
