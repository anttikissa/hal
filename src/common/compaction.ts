// The summary a compact record (task bc) stands in for the records
// before it with, built without a model call, as the old Hal did: the
// first prompt and the answer after it, the last three prompts and
// every answer after the first of them, each under its record number;
// every omitted run is one line counting what it held. Long answers
// keep their head and tail. Pure: the host stores the result in the
// record, so provider input stays byte-stable afterwards.

import { replay, type HistoryRecord } from './replay.ts'

const HEAD_BYTES = 1024
const TAIL_BYTES = 2048

const encoder = new TextEncoder()
const bytes = (s: string) => encoder.encode(s).length

// The longest prefix (or suffix) of `text` within `limit` UTF-8 bytes.
function fit(text: string, limit: number, suffix: boolean): string {
	let lo = 0
	let hi = text.length
	while (lo < hi) {
		let mid = suffix ? Math.floor((lo + hi) / 2) : Math.ceil((lo + hi) / 2)
		let ok = bytes(suffix ? text.slice(mid) : text.slice(0, mid)) <= limit
		if (suffix === ok) hi = suffix ? mid : mid - 1
		else lo = suffix ? mid + 1 : mid
	}
	return suffix ? text.slice(lo) : text.slice(0, lo)
}

const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))}kB`

// Assistant text over head + tail bytes as its head, a size marker and
// its tail.
function trim(text: string): string {
	let size = bytes(text)
	let kept = HEAD_BYTES + TAIL_BYTES
	if (size <= kept) return text
	return `${fit(text, HEAD_BYTES, false)}[...block of size ${kb(size)} trimmed down to ${kb(kept)}...]${fit(text, TAIL_BYTES, true)}`
}

// The conversation records a summary is made of: prompts, tool results
// and assistant blocks, as the conversation now stands (edits applied),
// from the latest reset on. Earlier summaries are not in it: a second
// compact summarises from the start again.
function entries(records: HistoryRecord[]): HistoryRecord[] {
	let from = records.findLastIndex((r) => r.type === 'reset')
	return replay.current(records.slice(from + 1)).filter((r) => r.type === 'user' || r.type === 'assistant')
}

function promptText(r: HistoryRecord): string {
	if (r.type !== 'user') return ''
	return r.blocks.flatMap((b) => (b.type === 'text' ? [replay.framed(b)] : [])).join('\n\n')
}

const isText = (r: HistoryRecord) => r.type === 'assistant' && r.block.type === 'text'

// Indexes of the entries kept word for word.
function kept(list: HistoryRecord[]): Set<number> {
	let out = new Set<number>()
	let users = list.flatMap((r, i) => (replay.isPrompt(r) ? [i] : []))
	if (!users.length) return out
	out.add(users[0]!)
	let answer = list.findIndex((r, i) => i > users[0]! && isText(r))
	if (answer >= 0) out.add(answer)
	let tail = users.slice(-3)
	for (let i of tail) out.add(i)
	for (let i = tail[0]! + 1; i < list.length; i++) if (isText(list[i]!)) out.add(i)
	return out
}

function count(parts: string[], n: number, what: string): void {
	if (n) parts.push(`${n} ${what}${n === 1 ? '' : 's'}`)
}

// One line for the omitted entries `run`: what they held, by kind.
function omission(run: HistoryRecord[], label: (r: HistoryRecord, i: number) => string): string {
	let calls = 0, results = 0, thinking = 0, text = 0, prompts = 0
	for (let r of run) {
		if (r.type === 'assistant') {
			if (r.block.type === 'tool_call') calls++
			else if (r.block.type === 'thinking') thinking++
			else text++
		} else if (r.type === 'user') {
			results += r.blocks.filter((b) => b.type === 'tool_result').length
			if (replay.isPrompt(r)) prompts++
		}
	}
	let parts: string[] = []
	count(parts, calls, 'tool call')
	count(parts, results, 'tool result')
	count(parts, thinking, 'thinking block')
	count(parts, text, 'assistant block')
	count(parts, prompts, 'prompt')
	if (!parts.length) return ''
	let first = label(run[0]!, 0)
	let last = label(run.at(-1)!, run.length - 1)
	return `[${first === last ? first : `${first}-${last}`}] ${parts.join(', ')} omitted`
}

// The summary of `records` (a session's whole history), naming
// `historyPath` for the rest, and how many prompts it covers; undefined
// when there is no conversation to summarise (an active prompt may be protected).
function summary(records: HistoryRecord[], historyPath: string): { summary: string; prompts: number } | undefined {
	let list = compaction.entries(records)
	let keep = compaction.kept(list)
	if (!list.length) return undefined
	// Each entry under its record number, the block id clients show.
	let label = (r: HistoryRecord, i: number) => String(r.n ?? i + 1)
	let lines = ['Context was compacted to avoid exceeding the token limit. Verify before assuming.', '', "Here's a summary of what happened (only user and assistant messages preserved):", '']
	let run: HistoryRecord[] = []
	let flush = () => {
		let line = run.length ? compaction.omission(run, (r) => label(r, list.indexOf(r))) : ''
		if (line) lines.push(line)
		run = []
	}
	for (let [i, r] of list.entries()) {
		if (!keep.has(i)) {
			run.push(r)
			continue
		}
		flush()
		if (r.type === 'user') lines.push(`[${label(r, i)}] user: ${promptText(r)}`)
		else if (r.type === 'assistant' && r.block.type === 'text') lines.push(`[${label(r, i)}] assistant: ${compaction.trim(r.block.text)}`)
	}
	flush()
	lines.push('', `Full history: ${historyPath} (read it with bash for anything left out)`)
	return { summary: lines.join('\n'), prompts: list.filter((r) => replay.isPrompt(r)).length }
}

export const compaction = { trim, entries, kept, omission, summary }
