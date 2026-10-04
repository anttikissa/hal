/// <reference lib="dom" />
// The web /rebase view's decisions (task bzf), without Solid: which
// action each row has, what the plan is, ranges, quick actions, and
// the host's answer. Rebase.tsx draws `rebaseView.state`; nothing is
// sent before Apply.
import { connection } from '../common/connection.ts'
import type { Event } from '../common/protocol.ts'
import type { RebasePlan } from '../common/rebase.ts'
import { rebaseRows, type RebaseRow, type RebaseRows } from '../common/rebase-rows.ts'
import { toolDetails } from '../common/tool-details.ts'
import { app } from './app.ts'

export type Action = 'keep' | 'drop' | 'edit'
// `actions`/`texts`: by row number; absent is keep. `anchor`: the last
// row acted on, where a range starts. `range`: phone range mode (the
// next action spans from the anchor). `sending`: the apply command's id
// until its result; `error`: the host's refusal, whole.
export type RebaseState = {
	sessionId: string; snapshot: RebaseRows; actions: Record<number, Action>; texts: Record<number, string>
	open: Record<number, true>; anchor?: number; range: boolean; threshold: number; sending?: string; error?: string
}
// What an opened row shows: its records' text, images and blobs.
export type Part = { kind: 'text'; label: string; text: string } | { kind: 'image'; blob: string; bytes?: number } | { kind: 'blob'; id: string; size: string }

const kinds = new Set(['prompt', 'assistant', 'thinking', 'compact', 'reset'])

function set(next: RebaseState | undefined): void {
	rebaseView.state = next
	rebaseView.changed()
}

// A new plan; one for the session already shown keeps the user's
// choices for rows that still exist (a rebuild after a stale base).
function open(event: Event & { type: 'rebase-plan' }): void {
	let old = rebaseView.state?.sessionId === event.sessionId ? rebaseView.state : undefined
	let has = new Set(event.snapshot.rows.map((r) => r.n))
	let keepOld = <T>(m: Record<number, T> | undefined) => Object.fromEntries(Object.entries(m ?? {}).filter(([n]) => has.has(Number(n)))) as Record<number, T>
	set({ sessionId: event.sessionId, snapshot: event.snapshot, actions: keepOld(old?.actions), texts: keepOld(old?.texts), open: keepOld(old?.open), range: false, threshold: old?.threshold ?? 5000 })
}

// Record numbers a row's own drop takes out: its group (signed thinking
// with its answer, a call with its result).
function dropped(st: RebaseState): Set<number> {
	return new Set(st.snapshot.rows.filter((r) => st.actions[r.n] === 'drop').flatMap((r) => r.group))
}

// keep, drop (own or by its group) or edit, as the row shows it.
function shown(st: RebaseState, row: RebaseRow, gone = rebaseView.dropped(st)): Action | 'group' {
	let own = st.actions[row.n] ?? 'keep'
	if (own === 'drop') return 'drop'
	return row.ns.some((n) => gone.has(n)) ? 'group' : own
}

function plan(st: RebaseState): RebasePlan {
	let gone = rebaseView.dropped(st)
	let drop = [...new Set(st.snapshot.rows.filter((r) => st.actions[r.n] === 'drop').flatMap((r) => r.ns))]
	let edit = st.snapshot.rows.flatMap((r) => st.actions[r.n] === 'edit' && r.editN !== undefined && !gone.has(r.editN) && st.texts[r.n] !== undefined && st.texts[r.n] !== r.text ? [{ n: r.editN, text: st.texts[r.n]! }] : [])
	return { base: st.snapshot.base, drop, edit }
}

// Sets `action` on row n, or on every row from the anchor to n when
// `extend` (shift-click, or range mode's second tap). Keeping or
// editing a row another row's drop takes with it keeps that row too.
function act(n: number, action: Action, extend = false): void {
	let st = rebaseView.state
	if (!st) return
	let rows = st.snapshot.rows, at = rows.findIndex((r) => r.n === n)
	if (at < 0) return
	extend ||= st.range && st.anchor !== undefined
	let from = extend && st.anchor !== undefined ? rows.findIndex((r) => r.n === st.anchor) : at
	if (from < 0) from = at
	let targets = action === 'edit' ? [rows[at]!] : rows.slice(Math.min(from, at), Math.max(from, at) + 1)
	let actions = { ...st.actions }, texts = { ...st.texts }
	for (let row of targets) {
		if (action === 'edit' && !row.editable) continue
		if (action !== 'drop') for (let other of rows) if (actions[other.n] === 'drop' && other.n !== row.n && row.ns.some((x) => other.group.includes(x))) delete actions[other.n]
		if (action === 'keep') delete actions[row.n]
		else actions[row.n] = action
		if (action === 'edit') texts[row.n] ??= row.text ?? ''
	}
	set({ ...st, actions, texts, anchor: n, range: st.range && st.anchor === undefined, error: undefined })
}

function patch(change: Partial<RebaseState>): void {
	if (rebaseView.state) set({ ...rebaseView.state, ...change })
}

function edit(n: number, text: string): void {
	let st = rebaseView.state
	if (st) set({ ...st, texts: { ...st.texts, [n]: text } })
}

function toggle(n: number): void {
	let st = rebaseView.state
	if (!st) return
	let open = { ...st.open }
	if (open[n]) delete open[n]
	else open[n] = true
	set({ ...st, open })
}

// Quick actions: drop every tool or command output of at least
// `threshold` tokens; drop every row before row n.
function dropOver(): void {
	let st = rebaseView.state
	if (!st) return
	let actions = { ...st.actions }
	for (let r of st.snapshot.rows) if (!kinds.has(r.kind) && r.tokens >= st.threshold) actions[r.n] = 'drop'
	set({ ...st, actions })
}

function dropBefore(n: number): void {
	let st = rebaseView.state
	if (!st) return
	let actions = { ...st.actions }
	for (let r of st.snapshot.rows) {
		if (r.n === n) break
		actions[r.n] = 'drop'
	}
	set({ ...st, actions })
}

function dirty(st: RebaseState): boolean {
	let p = rebaseView.plan(st)
	return p.drop.length > 0 || p.edit.length > 0
}

function apply(): void {
	let st = rebaseView.state
	if (!st || st.sending || !rebaseView.dirty(st)) return
	let id = connection.nextId()
	set({ ...st, sending: id, error: undefined })
	connection.send({ type: 'rebase-apply', id, sessionId: st.sessionId, base: st.snapshot.base, plan: rebaseView.plan(st) })
}

// Asks the host for fresh rows (after a stale base); choices carry over.
function rebuild(): void {
	let st = rebaseView.state
	if (st && !st.sending) connection.send({ type: 'submit', sessionId: st.sessionId, text: '/rebase' })
}

// The host's answer to this page's apply: success closes the view and
// says so; a refusal stays, whole, with the plan kept for another try.
function result(event: Event & { type: 'rebase-result' }): string | undefined {
	let st = rebaseView.state
	if (!st || !event.command || event.command !== st.sending) return
	if (event.ok) {
		set(undefined)
		return event.text
	}
	set({ ...st, sending: undefined, error: event.text })
}

// Rebase events, before the shown-tab filter: the plan opens the view
// whatever tab asked; a result for this page's apply closes it.
function onEvent(event: Event): boolean {
	if (event.type === 'rebase-plan') rebaseView.open(event)
	else if (event.type === 'rebase-result') {
		let text = rebaseView.result(event)
		if (text) app.setNotice(text)
	} else return false
	return true
}

// One row's records as readable parts, never JSON.
function parts(st: RebaseState, row: RebaseRow): Part[] {
	let out: Part[] = [], text = (label: string, t: string) => t && out.push({ kind: 'text', label, text: t })
	for (let n of row.ns) {
		let r = st.snapshot.records.find((r) => r.n === n)
		if (!r) continue
		if (r.type === 'user') for (let b of r.blocks) {
			if (b.type === 'text') text('', b.text)
			else if (b.type === 'image') out.push({ kind: 'image', blob: b.blob, bytes: b.bytes })
			else if (b.type === 'tool_result') {
				text(b.isError ? 'error' : 'output', b.output)
				if (b.image) out.push({ kind: 'image', blob: b.image.blob, bytes: b.image.bytes })
			}
		} else if (r.type === 'assistant') {
			let b = r.block
			// Bash's lines start with its $ command; other tools' with the rest.
			let lines = b.type === 'tool_call' ? toolDetails.lines(b.name, b.input) : []
			if (b.type === 'tool_call') text('call', (b.name === 'bash' ? lines : [toolDetails.headline(b.name, b.input).text, ...lines]).join('\n'))
			else text('', b.text)
		} else if (r.type === 'command' || r.type === 'output') text(r.type === 'output' ? 'output' : '', r.text)
		else if (r.type === 'compact') text('summary', r.summary)
	}
	for (let c of row.carries) {
		let m = /^blob (\S+)(?: (.+))?$/.exec(c)
		if (m) out.push({ kind: 'blob', id: m[1]!, size: m[2] ?? '' })
	}
	return out
}

// Row and total token counts as the terminal file writes them.
const kilo = (n: number): string => (n < 1000 ? String(n) : `${Math.round(n / 100) / 10}k`)

export const rebaseView = {
	state: undefined as RebaseState | undefined,
	// main/Chat points this at a redraw.
	changed: (): void => {},
	onEvent, open, act, edit, toggle, dropOver, dropBefore, apply, rebuild, result, plan, shown, dropped, parts, dirty, kilo,
	threshold: (tokens: number): void => patch({ threshold: Math.max(0, Math.round(tokens) || 0) }),
	range: (on: boolean): void => patch({ range: on, anchor: on ? undefined : rebaseView.state?.anchor }),
	cancel: (): void => set(undefined),
	totals: (st: RebaseState) => rebaseRows.totals(st.snapshot, rebaseView.plan(st)),
}
