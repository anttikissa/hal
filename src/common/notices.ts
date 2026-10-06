// The notice stack (task qm), both clients: short messages at the
// bottom right, just above the tabs, newest at the bottom. Any source
// adds entries by key (a newer one with the same key replaces it);
// each goes after ttl() unless it `stays` until its source removes it.
// Beyond max() entries the oldest fold into one '+N more' line.
// onChange is the client's repaint.
import { titles } from './titles.ts'

export type NoticeKind = 'done' | 'failed' | 'attention' | 'update' | 'commit' | 'warning'
// What the host sends when another tab's turn ends or asks (host/notify.ts)
// or commits (host/commits.ts, its own key so it never replaces the others;
// `what` overrides the kind's word, as 'amended' for an amend).
// `color`: the sending tab's project color (colors.project p0..p7), set
// when tabs have colors; the card takes it instead of the kind's.
export type NoticeEvent = { type: 'notice'; session: string; tab?: number; color?: number; name: string; kind: NoticeKind; line: string; key?: string; what?: string }
export type Notice = { key: string; kind: NoticeKind; title: string; line: string; session?: string; tab?: number; color?: number; stays?: true; at: number }
export type Folded = { shown: Notice[]; more?: { count: number; tabs: number[] } }

// A history entry (task py, host/notice-history.ts): `block` is the
// triggering record's key; `awaiting` whether a question is still open.
export type NoticeEntry = { id: string; at: string; session: string; name: string; kind: NoticeKind; line: string; what?: string; block?: string; awaiting?: boolean }

// 'update': a mid-turn notify-tool line, which neither ends the turn nor asks.
const WORDS: Record<NoticeKind, string> = { done: 'done', failed: 'failed', attention: 'needs your attention', update: 'update', commit: 'committed', warning: 'warning' }

// Why a history entry was sent, in words that claim no more than
// happened (both clients' notification history).
function reason(e: NoticeEntry): string {
	if (e.kind === 'attention') return e.awaiting ? 'waiting for an answer' : 'asked; answered'
	return e.what ?? WORDS[e.kind]
}

// An entry's time, as every transcript block shows it (task ta).
function stamp(at: string): string {
	return titles.time(at)
}

function fromEvent(e: NoticeEvent): Omit<Notice, 'at'> {
	let n: Omit<Notice, 'at'> = { key: e.key ?? `session:${e.session}`, kind: e.kind, title: `${e.tab ?? ''} ${e.name} · ${e.what ?? WORDS[e.kind]}`.trim(), line: e.line, session: e.session }
	if (e.tab !== undefined) n.tab = e.tab
	if (e.color !== undefined) n.color = e.color
	return n
}

function add(n: Omit<Notice, 'at'>, now = Date.now()): void {
	notices.state.entries = [...notices.state.entries.filter((e) => e.key !== n.key), { ...n, at: now }]
	notices.schedule(now)
	notices.onChange()
}

function remove(key: string): void {
	let left = notices.state.entries.filter((e) => e.key !== key)
	if (left.length === notices.state.entries.length) return
	notices.state.entries = left
	notices.onChange()
}

// Drops what outlived ttl() at `now`; true if anything went.
function expire(now = Date.now()): boolean {
	let left = notices.state.entries.filter((e) => e.stays || now - e.at < notices.ttl)
	if (left.length === notices.state.entries.length) return false
	notices.state.entries = left
	return true
}

// One timer, for the next entry to go.
function schedule(now = Date.now()): void {
	clearTimeout(notices.state.timer)
	let ends = notices.state.entries.filter((e) => !e.stays).map((e) => e.at + notices.ttl)
	if (!ends.length) return void (notices.state.timer = undefined)
	notices.state.timer = setTimeout(() => {
		if (notices.expire()) notices.onChange()
		notices.schedule()
	}, Math.max(0, Math.min(...ends) - now))
}

// What the stack shows: the newest max(), the rest counted with their tab numbers.
function fold(entries: Notice[], max = notices.max): Folded {
	if (entries.length <= max) return { shown: entries }
	let hidden = entries.slice(0, entries.length - max)
	let tabs = hidden.flatMap((e) => (e.tab === undefined ? [] : [e.tab]))
	return { shown: entries.slice(-max), more: { count: hidden.length, tabs } }
}

function moreText(more: NonNullable<Folded['more']>): string {
	return `+${more.count} more${more.tabs.length ? ` (${more.tabs.join(', ')})` : ''}`
}

function reset(): void {
	clearTimeout(notices.state.timer)
	notices.state = { entries: [], timer: undefined }
}

export const notices = {
	state: { entries: [] as Notice[], timer: undefined as ReturnType<typeof setTimeout> | undefined },
	ttl: 5000,
	max: 3,
	onChange: (): void => {},
	words: WORDS,
	reason,
	stamp,
	fromEvent,
	add,
	remove,
	expire,
	schedule,
	fold,
	moreText,
	reset,
}
