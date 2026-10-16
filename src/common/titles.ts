// What a block's header says (task hp): its local time and who wrote
// it, the same words in the terminal and on the web. Background
// command completion wording belongs here (task 778); stored labels stay intact.
// Tasks: rqq.

import type { Shown } from './transcript.ts'
import { bashResult } from './bash-result.ts'
import { card } from './card.ts'
import { summary } from './summary.ts'

// Names sent by the host's cached models.dev catalog; fall back to the
// complete id, never a guessed marketing name.
function modelName(id: string): string {
	return titles.names[id] ?? id
}

// The name where space is tight (task r7r): Claude and GPT only, the
// most used; 'Claude Opus 5.5' → 'Opus 5.5', 'GPT-6.1 Sol' → 'Sol 6.1'.
function shortName(id: string, name = titles.modelName(id)): string {
	return name.replace(/^Claude (?=\S)/, '').replace(/^GPT-([\d.]+) (Sol|Luna|Terra|Astra|Codex)$/, '$2 $1')
}

// '<name> <effort>', the effort left out at the model's default.
function modelLabel(id: string, effort?: string, full = false): string {
	let name = full ? titles.modelName(id) : titles.shortName(id)
	return effort && effort !== titles.defaults[id] ? `${name} ${effort}` : name
}

// Spawn slots left (task r92): 1–8 as a braille pile filled from the
// bottom, ⡀ … ⣿; above 8 the plain number; 0 nothing.
function budget(slots: number): string {
	return slots > 8 ? String(slots) : slots >= 1 ? '⡀⣀⣄⣤⣦⣶⣷⣿'[slots - 1]! : ''
}

function learn(event: { names: Record<string, string>; defaults?: Record<string, string> }): void {
	Object.assign(titles.names, event.names)
	Object.assign(titles.defaults, event.defaults)
}

// Local HH:MM of an ISO time, as '2 Oct HH:MM' if not today (local);
// '' without one. Memoized per minute string for the process: a header
// keeps its first text, so midnight rewrites no scrollback (which would
// clear the terminal); a restart dates it. A long history's headers
// share few parses (the startup budget, kn).
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const times = new Map<string, string>()
function time(ts: string | undefined): string {
	if (ts === undefined) return ''
	let today = new Date().toDateString()
	let key = ts.endsWith('Z') ? ts.slice(0, 16) : ts
	let hit = times.get(key)
	if (hit !== undefined) return hit
	let d = new Date(ts)
	let t = Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
	if (t && d.toDateString() !== today) t = `${d.getDate()} ${months[d.getMonth()]} ${t}`
	times.set(key, t)
	return t
}

function resultTime(call: string | undefined, result: string | undefined): string {
	let time = titles.time(result)
	return time === titles.time(call) ? '' : time
}

// A one-row block's text behind its time: '10:52 Paused.'.
function stamp(ts: string | undefined, text: string): string {
	let t = titles.time(ts)
	return t ? `${t} ${text}` : text
}

// A turn end's row: '10:52 Paused.', '10:52 Interrupted.'.
function ended(ts: string | undefined, status: string): string {
	return stamp(ts, `${status[0]!.toUpperCase()}${status.slice(1)}.`)
}

// 'who (a, b)': a sender and its tags, or the sender alone.
function tagged(who: string, tags: (string | false | undefined)[]): string {
	let list = tags.filter((t) => t)
	return list.length ? `${who} (${list.join(', ')})` : who
}

// A recorded tabs.label without middle dots; a short card address
// retains the send-time tab and id, while details also keep the name.
function address(label: string, short = false): string {
	let [first, id, ...name] = label.split(' · ')
	if (!id) return label
	let who = /^tab \d+$/.test(first!) ? `${first} (${id})` : first!
	let rest = /^tab \d+$/.test(first!) ? name : [id, ...name]
	return !short && rest.length ? `${who}, ${rest.join(', ')}` : who
}

function messageHead(item: Shown & { type: 'prompt' }): string {
	return titles.compact(item) ?? titles.who(item) ?? ''
}

// "tab 2 · 12-xyz · Name" → ['12-xyz', 'tab 2']: the session, then its tab.
function sender(label: string): [string, string | undefined] {
	let [first, id] = label.split(' · ')
	return /^tab \d+$/.test(first!) && id ? [id, first] : [first!, undefined]
}

// Receipts describe model delivery, not transport acknowledgement of normal prompts.
function receipt(item: Shown): 0 | 1 | 2 {
	return item.type === 'prompt' && !bashResult.background(item) && ((item.delivery === 'next-round') || (item.delivery === 'after-turn') || item.queuedAt) ? item.waiting ? 1 : 2 : 0
}

// Who wrote `item`, or undefined for an item without a header.
function who(item: Shown): string | undefined {
	let label = titles.author(item)
	return label !== undefined && item.originSession !== undefined ? `${label} (in ${item.originSession})` : label
}

function author(item: Shown): string | undefined {
	switch (item.type) {
		case 'prompt': {
			let call = bashResult.background(item)
			let delivery = [item.edited && 'edited; /edit undo to go back', item.generatingCommand && `/${item.generatingCommand} continuation`, (item.delivery === 'now') && 'steering', (item.delivery === 'next-round') && 'next round', item.queuedAt ? `queued at ${titles.time(item.queuedAt)}` : (item.delivery === 'after-turn') && 'queued']
			if (call) return `Bash output ↑ ${/^\d+$/.test(call) ? `t${call}` : call}`
			if (item.from === undefined) return tagged(item.origin === 'model' ? 'Hal' : 'You', delivery)
			let [id, tab] = sender(item.label ?? item.from)
			return tagged(`From ${item.from || id}`, [tab, item.report === 'question' ? 'question' : item.report === 'summary' ? 'done' : undefined, ...delivery])
		}
		// Another session's command is headed as the prompt it was sent
		// as; the human's by itself, over what it said (none alone).
		case 'command':
			return item.from !== undefined ? `Command from ${item.label ?? item.from}` : item.output === undefined ? undefined : item.text
		// The reply's header names model and effort (task r7r).
		case 'thinking':
			return 'Thinking'
		case 'text':
			return tagged('Hal', [item.model && titles.modelLabel(item.model, item.effort), !item.interrupted && !item.naming && (summary.asks(item.text) ? 'question' : summary.extract(item.text) ? 'done' : undefined)])
		// Hal's own words without a model, such as a greeting (task 8y).
		case 'output':
			return item.commit ? (item.commit.amend ? 'Amended' : 'Committed') : item.error ? 'Error' : item.synthetic ? 'Hal (synthetic)' : undefined
	}
}

function preview(text: string): string {
	return text.match(/\S[^\r\n]*/)?.[0]?.replace(/\s+/g, ' ').trim() ?? ''
}

function compact(item: Shown): string | undefined {
	if (item.type !== 'prompt' && item.type !== 'text') return undefined
	let who = titles.who(item)
	let text = titles.preview(item.type === 'prompt' ? item.summary || card.text(item) : card.text(item))
	return text ? `${who}: ${text}` : who
}

// '10:52 Hal (Opus 5.5)', '10:52 Run this command? …' for a question;
// undefined for an item without a header.
function title(item: Shown): string | undefined {
	if (item.type === 'question') return stamp(item.ts, item.form.text)
	if (item.type === 'output' && !item.synthetic && !item.commit && !item.error) return titles.time(item.ts) || undefined
	let w = item.type === 'prompt' && item.report && item.summary ? titles.compact(item) : titles.who(item)
	if (w === undefined) return undefined
	let t = titles.time((item as { ts?: string }).ts)
	return t ? `${t} ${w}` : w
}

// The kind letter of a block id (task 9p): who produced the block.
// u the user typed it; m another session sent it; a assistant text; r
// thinking; t a tool call or its result; q a question, Hal's or the
// intro's; s Hal's own output (command output, notices, background job
// results).
function letter(item: Shown): string {
	switch (item.type) {
		case 'prompt':
			return item.from === undefined ? (item.origin === 'model' ? 's' : 'u') : item.label?.startsWith('bash ') ? 's' : 'm'
		case 'image':
			return 'u'
		case 'command':
			return item.from === undefined ? 'u' : 'm'
		case 'text':
			return 'a'
		case 'thinking':
			return 'r'
		case 'tool':
		case 'tool-result':
			return 't'
		case 'question':
			return 'q'
		default:
			return 's'
	}
}

// The block id `item` shows, 't19': its letter, then its key (the
// record's history line number, task w5).
function blockId(item: Shown & { key: string }): string {
	return titles.letter(item) + item.key
}

export const titles = { names: {} as Record<string, string>, defaults: {} as Record<string, string>, modelName, shortName, modelLabel, budget, learn, time, resultTime, stamp, ended, address, receipt, messageHead, preview, compact, author, who, title, letter, blockId }
