// /go switches only clients following the session that runs it, to a
// session and optionally a block in it (task 4qh).
import { relative, resolve } from 'path'
import { replay } from '../../common/replay.ts'
import { titles } from '../../common/titles.ts'
import { toolDetails } from '../../common/tool-details.ts'
import { transcript, type Item } from '../../common/transcript.ts'
import { clients } from '../clients.ts'
import { commands, type Candidate, type Context, type SlashCommand } from '../commands.ts'
import { history } from '../history.ts'
import { host } from '../host.ts'
import { tabs } from '../tabs.ts'
import { closedSessions } from './tabs.ts'

const closed = () => closedSessions().filter((s) => s.meta)
// Block completion lists at most this many, newest first: a long
// history would otherwise send thousands of rows per keystroke.
const maxBlocks = 100

// The session `text` names: a tab number, id, name or directory, open
// tabs first; `closed` when it must be reopened.
function session(text: string, ctx: Context): { id: string; closed?: true } | undefined {
	let list = tabs.list()
	let byNumber = /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? list[Number(text) - 1] : undefined
	let path = commands.expand(text, ctx.cwd)
	let open = byNumber ?? list.find((t) => t.id === text) ?? list.find((t) => t.name === text) ?? list.find((t) => resolve(t.cwd) === path)
	if (open) return { id: open.id }
	if (/^\d+$/.test(text)) return undefined
	let shut = closed()
	let s = shut.find((s) => s.id === text) ?? shut.find((s) => s.meta!.name === text) ?? shut.find((s) => resolve(s.meta!.cwd) === path)
	return s && { id: s.id, closed: true }
}

// What a closed block shows: a tool's description, else its first line.
function headline(item: Item): string {
	if (item.type === 'tool') return toolDetails.headline(item.name, item.input).text
	let text = item.type === 'prompt' && item.summary ? item.summary : item.type === 'question' ? item.form.text : item.type === 'image' ? 'image' : 'text' in item ? item.text : ''
	return text.trim().split('\n')[0]!.trim()
}

// Session `id`'s blocks with ids, in history order.
function blocks(id: string): Item[] {
	return replay.current(history.readSync(id)).flatMap((r, i) => transcript.recordItems(r, i)).filter((i) => /^\d+(\.\d+)?$/.test(i.key))
}

// '16:29' today, else '2 Oct 16:29', in the zone of the session's client.
function when(ts: string | undefined, ctx: Context, time = true): string {
	if (!ts || Number.isNaN(Date.parse(ts))) return ''
	let timeZone = clients.timezone(ctx.sessionId)
	let day = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone })
	if (!time) return day(new Date(ts))
	let hm = new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone })
	return day(new Date(ts)) === day(new Date()) ? hm : `${day(new Date(ts))} ${hm}`
}

// Blocks of `id` matching `rest` (kind letter, number prefix), newest first.
function blockRows(id: string, rest: string, prefix: string, ctx: Context): Candidate[] {
	let m = /^([a-z]?)(\d*(?:\.\d*)?)$/.exec(rest)
	if (!m) return []
	let rows = blocks(id).filter((i) => i.type !== 'tool-result' && i.type !== 'turn-end' && (!m[1] || titles.letter(i) === m[1]) && i.key.startsWith(m[2]!))
	return rows.slice(-maxBlocks).reverse().map((i) => ({ value: `${prefix}${titles.blockId(i)}`, description: [when((i as { ts?: string }).ts, ctx), headline(i)].filter(Boolean).join('  ') }))
}

// Open and closed sessions whose id or name starts with `text`.
function sessionRows(text: string, ctx: Context): Candidate[] {
	let low = text.toLowerCase()
	let hit = (id: string, name?: string) => id.startsWith(text) || !!name?.toLowerCase().startsWith(low)
	let open = tabs.list().map((t, i) => ({ id: t.id, name: t.name === t.id ? undefined : t.name, where: `tab ${i + 1}` }))
	let shut = closed().map((s) => ({ id: s.id, name: s.meta!.name, where: ['closed', when(s.meta!.closedAt, ctx, false)].filter(Boolean).join(', ') }))
	return [...open, ...shut].filter((s) => hit(s.id, s.name)).map((s) => ({ value: s.id, description: `${s.name ? `${s.name} ` : ''}(${s.where})` }))
}

// Session directories, written the way `text` starts (~/, /, .).
function dirRows(text: string, ctx: Context): Candidate[] {
	let home = commands.home()
	let show = (d: string) => {
		if (text.startsWith('~')) return d === home ? '~' : d.startsWith(home + '/') ? '~' + d.slice(home.length) : d
		if (!text.startsWith('.')) return d
		let r = relative(ctx.cwd, d)
		return !r ? '.' : r.startsWith('..') ? r : `./${r}`
	}
	let dirs = [...new Set([...tabs.list().map((t) => t.cwd), ...closed().map((s) => s.meta!.cwd)])]
	return [...new Set(dirs.map(show))].filter((d) => d.startsWith(text)).map((value) => ({ value, description: 'directory' }))
}

export const command: SlashCommand = {
	help: () => '/go <tab|session|directory>[#block]: go to a session, reopening it if closed, or to a block in it (#t12, 4#u7, 166-eta#a30). A directory picks its first open tab, else its newest session.',
	complete(args, ctx) {
		if (/^[~/.]/.test(args)) return dirRows(args, ctx)
		if (/^\d*$/.test(args)) return tabs.list().map((t, i) => ({ value: String(i + 1), description: t.name === t.id ? t.id : `${t.name}  ${t.id}` })).filter((c) => c.value.startsWith(args))
		let split = /^([^#/]+)[#/]#?(.*)$/.exec(args)
		if (split) {
			let s = session(split[1]!, ctx)
			return s ? blockRows(s.id, split[2]!, `${split[1]}#`, ctx) : []
		}
		let rows = args.startsWith('#') ? [] : sessionRows(args, ctx)
		return [...rows, ...blockRows(ctx.sessionId, args.replace(/^#/, ''), '#', ctx)]
	},
	run(args, _answers, ctx) {
		if (!args.trim()) return { error: 'give a tab number, session id, name or directory' }
		let target = session(args, ctx)
		let block: string | undefined
		if (!target) {
			// #n, k n, #kn: this session; <session>#<block> or <session>/<block>.
			let m = /^(?:(.+)[#/]#?|(#))?([a-z]?)(\d+(?:\.\d+)?)$/.exec(args)
			if (!m || (m[1] === undefined && !m[2] && !m[3])) return { error: `no session ${args}` }
			target = m[1] === undefined ? { id: ctx.sessionId } : session(m[1], ctx)
			if (!target) return { error: `no session ${m[1]}` }
			let hit = blocks(target.id).find((i) => i.key === m[4])
			if (!hit) return { error: `no block #${m[3]}${m[4]} in ${target.id}` }
			block = titles.blockId(hit)
		}
		if (target.closed) {
			let outcome = tabs.act({ type: 'tab-resume', sessionId: target.id })
			if (outcome.refused) return { error: outcome.refused }
		}
		host.broadcast(ctx.sessionId, { type: 'go', sessionId: ctx.sessionId, tab: target.id, ...(block && { block }) })
		return {}
	},
}
