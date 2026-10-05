// What a block's header says (task hp): its local time and who wrote
// it, the same words in the terminal and on the web.

import type { Shown } from './transcript.ts'

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

function learn(event: { names: Record<string, string>; defaults?: Record<string, string> }): void {
	Object.assign(titles.names, event.names)
	Object.assign(titles.defaults, event.defaults)
}

// Local HH:MM of an ISO time, as '2 Oct HH:MM' if not today (local);
// '' without one. "Today" is when rendered; nothing re-renders at
// midnight. Parsed once per minute string and day: a long history's
// headers share few (the startup budget, kn).
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const times = new Map<string, string>()
function time(ts: string | undefined): string {
	if (ts === undefined) return ''
	let today = new Date().toDateString()
	let key = `${today} ${ts.endsWith('Z') ? ts.slice(0, 16) : ts}`
	let hit = times.get(key)
	if (hit !== undefined) return hit
	let d = new Date(ts)
	let t = Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
	if (t && d.toDateString() !== today) t = `${d.getDate()} ${months[d.getMonth()]} ${t}`
	times.set(key, t)
	return t
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

// Who wrote `item`, or undefined for an item without a header.
function who(item: Shown): string | undefined {
	let label = titles.author(item)
	return label !== undefined && item.originSession !== undefined ? `${label} (in ${item.originSession})` : label
}

function author(item: Shown): string | undefined {
	switch (item.type) {
		case 'prompt':
			return tagged(item.from !== undefined ? `Message from ${item.label ?? item.from}` : item.origin === 'model' ? 'Hal' : 'You', [item.generatingCommand && `/${item.generatingCommand} continuation`, item.steering && 'steering', item.advisory && 'advisory', item.queued && (item.queuedAt ? `queued at ${titles.time(item.queuedAt)}` : 'queued')])
		// A command is headed as the prompt it was typed as.
		case 'command':
			return item.from === undefined ? 'You' : `Command from ${item.label ?? item.from}`
		// The reply's header names model and effort (task r7r).
		case 'thinking':
			return 'Thinking'
		case 'text':
			return item.model ? `Hal (${titles.modelLabel(item.model, item.effort)})` : 'Hal'
		// Hal's own words without a model, such as a greeting (task 8y).
		case 'output':
			return item.synthetic ? 'Hal (synthetic)' : undefined
	}
}

// '10:52 Hal (Opus 5.5)'; undefined for an item without a header.
function title(item: Shown): string | undefined {
	if ((item.type === 'output' && !item.synthetic) || item.type === 'question') return titles.time(item.ts) || undefined
	let w = titles.who(item)
	if (w === undefined) return undefined
	let t = titles.time((item as { ts?: string }).ts)
	return t ? `${t} ${w}` : w
}

// The kind letter of a block id (task 9p): who produced the block.
// u the user typed it; m another session sent it; a assistant text; r
// thinking; t a tool call or its result; s Hal's own output (command
// output, notices, background job results).
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
		default:
			return 's'
	}
}

// The block id `item` shows, 't19': its letter, then its key (the
// record's history line number, task w5).
function blockId(item: Shown & { key: string }): string {
	return titles.letter(item) + item.key
}

export const titles = { names: {} as Record<string, string>, defaults: {} as Record<string, string>, modelName, shortName, modelLabel, learn, time, stamp, ended, author, who, title, letter, blockId }
