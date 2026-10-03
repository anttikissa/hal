// The status row between the prompt box and the help row (task 1g),
// after the old Hal's renderStatusLine. Left, joined with ' · ': the
// session id (and its name), the cwd, the model and the context used;
// right-aligned: this process's role (or the remote host), the session's tokens this run and
// the subscription account's usage windows. When the row is too narrow
// the right parts go from the end, then the left is clipped. Pure.

import { titles } from '../common/titles.ts'
import { usageWindows } from '../common/usage-windows.ts'
import { colors } from '../common/colors.ts'
import type { Oklch } from '../common/oklch.ts'
import type { Stats } from '../common/protocol.ts'
import { strings } from '../common/strings.ts'
import { ansi } from './ansi.ts'

// `hal`: the cwd is the Hal repo; `home` is shortened to ~ in the cwd.
// `color`: the tab's project color (task 22).
export type StatusInfo = { id: string; name?: string; cwd: string; hal?: boolean; color?: Oklch; model: string; role?: string; stats?: Stats; home?: string }

type Part = { text: string; fg?: Oklch; href?: string }

const SEP = ' · '

// A token count as the row shows totals: 252, 4.1k, 41k, 1.2M, 12M.
function count(n: number): string {
	if (n < 1000) return String(n)
	if (n < 9_950) return `${(n / 1000).toFixed(1)}k`
	if (n < 999_500) return `${Math.round(n / 1000)}k`
	if (n < 9_950_000) return `${(n / 1_000_000).toFixed(1)}M`
	return `${Math.round(n / 1_000_000)}M`
}

// A context size in whole thousands: 87k, 1000k.
const kilo = (n: number): string => (n < 1000 ? String(n) : `${Math.round(n / 1000)}k`)

// The context used as a percentage of the window; none without one.
function percent(s: Stats | undefined): number | undefined {
	return s?.window ? Math.round(((s.context ?? 0) / s.window) * 100) : undefined
}

// The left side's groups: session, cwd, model, context.
function left(info: StatusInfo): Part[][] {
	let hi = colors.status().highlight!
	let out: Part[][] = [info.name ? [{ text: `${info.id}: ` }, { text: ansi.clean(info.name), fg: hi }] : [{ text: info.id }]]
	let home = info.home
	let cwd = home && (info.cwd === home || info.cwd.startsWith(`${home}/`)) ? `~${info.cwd.slice(home.length)}` : info.cwd
	out.push([{ text: ansi.clean(cwd), fg: info.color ?? (info.hal ? colors.assistant().fg! : hi) }])
	out.push([{ text: ansi.clean(`${titles.modelName(info.model)} (${info.stats?.effort ?? 'default/unknown'})`), fg: hi }])
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
// role, tokens, plan. Empty ones are left out.
function right(info: StatusInfo): Part[][] {
	let out: Part[][] = []
	if (info.role) out.push([{ text: info.role }])
	let s = info.stats
	let tokens = [s?.sent ? `↑${count(s.sent)}` : '', s?.received ? `↓${count(s.received)}` : ''].filter(Boolean).join(' ')
	if (tokens) out.push([{ text: tokens }])
	let plan = s?.plan
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
	let l = join(statusRow.left(info))
	let groups = statusRow.right(info)
	while (groups.length && width(l) + 1 + width(join(groups)) > cols) groups = groups.slice(0, -1)
	if (!groups.length) return clip(l, cols)
	let r = join(groups)
	return [...l, { text: ' '.repeat(cols - width(l) - width(r)) }, ...r]
}

// The painted row for a terminal `cols` wide.
function row(info: StatusInfo, cols: number): string {
	let base = ansi.sgr({ fg: colors.status().fg! })
	let parts = statusRow.fit(info, Math.max(1, cols - 2 * ansi.PAD.length))
	// Neighbouring parts with one href share a single link.
	let link: string | undefined
	let out = parts.map((p) => {
		let text = p.fg ? ansi.sgr({ fg: p.fg }) + p.text + base : p.text
		let pre = p.href === link ? '' : (link ? ansi.LINK_OFF : '') + (p.href ? `\x1b]8;;${ansi.webUrl(p.href)}\x07` : '')
		link = p.href
		return pre + text
	}).join('')
	return ansi.PAD + base + out + (link ? ansi.LINK_OFF : '') + ansi.UNCOLOR
}

export const statusRow = { count, percent, left, right, fit, row }
