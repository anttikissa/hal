// Who hears that a session needs the user (task qm): for a turn that
// completed or failed, or a question waiting. A client watching that
// session already sees it, so nothing goes; else each client watching
// another tab gets a notice (common/notices.ts) and no push goes; with
// nobody watching, a web push (push.ts, task m1). A client watches the
// session it last reported visible (host.ts, the `visibility` command).

import type { NoticeEvent, NoticeKind } from '../common/notices.ts'
import type { Event } from '../common/protocol.ts'
import { clients as clientInfo } from './clients.ts'
import { diag } from './diag.ts'
import { noticeHistory } from './notice-history.ts'
import { pages } from './pages.ts'
import { push } from './push.ts'
import { sessions } from './sessions.ts'
import { tabs } from './tabs.ts'
import { summary } from '../common/summary.ts'
import { names } from '../common/names.ts'

type Watcher = { deliver: (event: Event) => void; visible?: string; visibleAt?: number; record?: { kind?: string; userAgent?: string; lastAt?: number } }

// iOS can drop a page without saying it is hidden, leaving its socket
// "watching"; only a client heard from within a minute counts as present.
const presentMs = 60_000
function present(c: Watcher): boolean {
	return c.visible !== undefined && (c.record?.lastAt === undefined || Date.now() - c.record.lastAt < presentMs)
}

function kind(event: Event): NoticeKind | undefined {
	if (event.type === 'question') return 'attention'
	if (event.type !== 'turn-end') return undefined
	return event.status === 'completed' ? 'done' : event.status === 'error' ? 'failed' : undefined
}

// What the latest turn replied: its <summary> (common/summary.ts), else
// the last non-blank line of its text.
function replyLine(id: string): string {
	return notify.reply(id).line
}

// The reply line and the key of the record it came from.
function reply(id: string): { line: string; block?: string } {
	let records = pages.page(id).records
	for (let i = records.length - 1; i >= 0; i--) {
		let r = records[i]!
		if (r.type === 'user') break
		if (r.type !== 'assistant' || r.block.type !== 'text') continue
		let told = summary.extract(r.block.text)
		let block = r.n === undefined ? undefined : `${r.n}`
		if (told) return { line: told, block }
		let text = summary.strip(r.block.text)
		let last = names.strip(text).split('\n').map((l) => l.trim()).filter(Boolean).at(-1)
		if (last) return { line: last, block }
	}
	return { line: '' }
}

// One line saying what happened: the reply's last line, the error, or the question.
function line(id: string, event: Event): string {
	let text = event.type === 'question' ? event.form.text : event.type === 'turn-end' && event.error ? event.error : notify.replyLine(id)
	return (text.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 200)
}

function route(clients: Iterable<Watcher>, id: string, event: Event): void {
	let k = notify.kind(event)
	if (!k) return
	let all = [...clients]
	if (all.some((c) => present(c) && c.visible === id)) return diag.log(`push: ${id} not pushed, its tab is on screen`)
	let word = k === 'attention' ? 'needs an answer' : k === 'failed' ? 'failed' : 'done'
	let told = k === 'done' ? notify.reply(id) : undefined
	let block = event.type === 'question' ? (event.n === undefined ? undefined : `${event.n}`) : told?.block
	let source = { ...(block ? { block } : {}), ...(event.type === 'question' ? { question: event.id } : {}) }
	notify.deliver(all, id, k, notify.line(id, event), told?.line ? `${word}: ${told.line}` : word, source)
}

// The same routing for automatic events and a model's mid-turn notice.
// `source` names the triggering block and question for the history (task py).
function deliver(clients: Iterable<Watcher>, id: string, k: NoticeKind, line: string, pushText: string, source: { block?: string; question?: string } = {}): void {
	let all = [...clients]
	if (all.some((c) => present(c) && c.visible === id)) return diag.log(`push: ${id} not pushed, its tab is on screen`)
	let name = sessions.open(id).name ?? id
	noticeHistory.record({ session: id, name, kind: k, line, ...source })
	let watching = all.filter(present)
	if (!watching.length) return void push.notify(id, name, pushText).catch((e: any) => diag.log(`push: ${e?.message ?? e}`))
	let notice: NoticeEvent = { type: 'notice', session: id, name, kind: k, line }
	let tab = tabs.file().open.indexOf(id)
	if (tab >= 0) notice.tab = tab + 1
	for (let c of watching) c.deliver(notice)
	let who = watching.map((c) => `${c.record?.kind === 'web' ? clientInfo.shortAgent(c.record.userAgent) : `${c.record?.kind} terminal`} showing ${c.visible} for ${c.visibleAt ? Math.round((Date.now() - c.visibleAt) / 1000) : '?'}s`)
	diag.log(`push: ${id} not pushed, watched: ${who.join('; ')}`)
}

export const notify = { kind, replyLine, reply, line, route, deliver }
