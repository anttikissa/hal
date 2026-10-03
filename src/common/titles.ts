// What a block's header says (task hp): its local time and who wrote
// it, the same words in the terminal and on the web.

import type { Shown } from './transcript.ts'

// Names sent by the host's cached models.dev catalog; fall back to the
// complete id, never a guessed marketing name.
function modelName(id: string): string {
	return titles.names[id] ?? id
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
			return tagged(item.from !== undefined ? `Message from ${item.label ?? item.from}` : item.origin === 'model' ? 'Hal' : 'You', [item.generatingCommand && `/${item.generatingCommand} continuation`, item.steering && 'steering', item.advisory && 'advisory', item.queued && 'queued'])
		// A command is headed as the prompt it was typed as.
		case 'command':
			return item.from === undefined ? 'You' : `Command from ${item.label ?? item.from}`
		// Thinking names its effort, not the model: the reply's header
		// already does, and a closed card shows its first line instead.
		case 'thinking':
			return tagged('Thinking', [item.effort])
		case 'text':
			return item.model ? `Hal (${titles.modelName(item.model)})` : 'Hal'
		// Hal's own words without a model, such as a greeting (task 8y).
		case 'output':
			return item.synthetic ? 'Hal (synthetic)' : undefined
	}
}

// '10:52 Hal (Opus 5.5)'; undefined for an item without a header.
function title(item: Shown): string | undefined {
	if (item.type === 'output' && !item.synthetic) return titles.time(item.ts) || undefined
	let w = titles.who(item)
	if (w === undefined) return undefined
	let t = titles.time((item as { ts?: string }).ts)
	return t ? `${t} ${w}` : w
}

export const titles = { names: {} as Record<string, string>, modelName, time, author, who, title }
