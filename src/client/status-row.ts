// The status row between the prompt box and the help row (task 1g),
// after the old Hal's renderStatusLine. Left, joined with ' · ': the
// session id (and its name), the cwd, the model and the context used;
// right-aligned: this process's role (or the remote host) and the
// subscription account's usage windows, after any differing
// portable plugins (task b81). When the row is too narrow
// the right parts go from the end, then the left is clipped. Pure.

import { settings } from '../common/settings.ts'
import { titles } from '../common/titles.ts'
import { subscriptions } from '../common/subscriptions.ts'
import { usageWindows } from '../common/usage-windows.ts'
import { colors } from '../common/colors.ts'
import type { Oklch } from '../common/oklch.ts'
import type { Stats } from '../common/protocol.ts'
import { strings } from '../common/strings.ts'
import { ansi } from './ansi.ts'

// `hal`: the cwd is the Hal repo; `home` is shortened to ~ in the cwd.
// `color`: the tab's project color (task 22).
// `plugins`: the plugin sync indicator of a remote terminal (task b81).
export type StatusInfo = { id: string; name?: string; autoclose?: boolean; slots?: number; cwd: string; hal?: boolean; color?: Oklch; model: string; role?: string; stats?: Stats; home?: string; plugins?: string }

type Part = { text: string; fg?: Oklch; href?: string }

const SEP = ' · '

// A context size in whole thousands: 87k, 1000k.
const kilo = (n: number): string => (n < 1000 ? String(n) : `${Math.round(n / 1000)}k`)

// The context used as a percentage of the window; none without one.
function percent(s: Stats | undefined): number | undefined {
	return s?.window ? Math.round(((s.context ?? 0) / s.window) * 100) : undefined
}

// The left side's groups: session, cwd, model, context.
function left(info: StatusInfo, full = true): Part[][] {
	let hi = colors.status().highlight!
	let out: Part[][] = [info.name ? [{ text: `${info.id}: ` }, { text: ansi.clean(info.name) + (info.autoclose ? ' ↧' : ''), fg: hi }] : [{ text: info.id + (info.autoclose ? ' ↧' : '') }]]
	let home = info.home
	let cwd = home && (info.cwd === home || info.cwd.startsWith(`${home}/`)) ? `~${info.cwd.slice(home.length)}` : info.cwd
	out.push([{ text: ansi.clean(cwd), fg: info.color ?? (info.hal ? colors.assistant().fg! : hi) }])
	out.push([{ text: ansi.clean(titles.modelLabel(info.model, info.stats?.effort, full)), fg: hi }, { text: ` b${info.slots ?? settings.subagentSlots()}`, href: '/budget' }])
	let s = info.stats
	if (s?.files) out.push([{ text: `${s.files} files`, href: `/changes/${info.id}` }])
	let pct = statusRow.percent(s)
	if (pct !== undefined) {
		let fg = colors.heat(pct)
		out.push([{ text: kilo(s!.context ?? 0), fg }, { text: `/${kilo(s!.window!)} (` }, { text: `${pct}%`, fg }, { text: ')' }].map((p) => ({ ...p, href: `/context/${info.id}` })))
	} else if (s?.context) out.push([{ text: kilo(s.context), href: `/context/${info.id}` }])
	return out
}

// The right side's groups, in the order they are dropped from the end:
// plugins, role, plan. Empty ones are left out.
function right(info: StatusInfo): Part[][] {
	let out: Part[][] = []
	if (info.plugins) out.push([{ text: ansi.clean(info.plugins), fg: colors.warning().fg! }])
	if (info.role) out.push([{ text: info.role }])
	let s = info.stats
	let plan = s?.plan && { ...s.plan, ...subscriptions.plan(s.plan) }
	if (plan) {
		let parts: Part[] = [{ text: `Sub${plan.accounts > 1 ? ` ${plan.account}/${plan.accounts}` : ''}` }]
		let moot = usageWindows.moot(Object.entries(plan.windows).map(([name, used]) => ({ name, used, resets: plan.resets?.[name] })))
		Object.entries(plan.windows).filter(([name]) => !moot.has(name)).forEach(([name, pct], i) => parts.push({ text: `${i ? ', ' : ': '}${name} ` }, { text: `${pct}%`, fg: colors.heat(pct) }))
		out.push(parts)
	}
	return out
}

const join = (groups: Part[][]): Part[] => groups.flatMap((g, i) => (i ? [{ text: SEP }, ...g] : g))
const width = (parts: Part[]): number => strings.visLen(parts.map((p) => p.text).join(''))

// The first `max` columns of `parts`.
function clip(parts: Part[], max: number): Part[] {
	let out: Part[] = []
	for (let p of parts) {
		let room = max - width(out)
		if (room <= 0) break
		out.push(strings.visLen(p.text) <= room ? p : { ...p, text: strings.clipVisual(p.text, room) })
	}
	return out
}

// The row's parts in `cols` columns of content: the left, a gap, and
// as many right groups as fit beside the whole left, at least one
// column apart; the left clipped only when nothing is on the right.
function fit(info: StatusInfo, cols: number): Part[] {
	let groups = statusRow.right(info)
	// The official model name if the whole row fits, else the short one.
	let l = join(statusRow.left(info))
	if (width(l) + 1 + width(join(groups)) > cols) l = join(statusRow.left(info, false))
	while (groups.length && width(l) + 1 + width(join(groups)) > cols) groups = groups.slice(0, -1)
	if (!groups.length) {
		if (width(l) <= cols) return l
		let model = statusRow.left(info, false)[2]!
		let budget = model.at(-1)!
		let head = join([[{ text: info.id }], model])
		if (width(head) <= cols) return head
		return [...clip([model[0]!], Math.max(0, cols - width([budget]))), ...clip([budget], cols)]
	}
	let r = join(groups)
	return [...l, { text: ' '.repeat(cols - width(l) - width(r)) }, ...r]
}

// The painted row for a terminal `cols` wide.
function row(info: StatusInfo, cols: number): string {
	let base = ansi.sgr({ fg: colors.status().fg! })
	let parts = statusRow.fit(info, Math.max(1, cols - 2 * ansi.PAD.length))
	// Neighboring parts with one href share a single link.
	let link: string | undefined
	let out = parts.map((p) => {
		let text = p.fg ? ansi.sgr({ fg: p.fg }) + p.text + base : p.text
		let pre = p.href === link ? '' : (link ? ansi.LINK_OFF : '') + (p.href ? `\x1b]8;;${ansi.webUrl(p.href)}\x07` : '')
		link = p.href
		return pre + text
	}).join('')
	return ansi.PAD + base + out + (link ? ansi.LINK_OFF : '') + ansi.UNCOLOR
}

export const statusRow = { percent, left, right, fit, row }
