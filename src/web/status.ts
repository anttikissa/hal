// The web status block's facts (tasks a0, 5f): the details dialog's
// groups, the overview's context, the model name's quota fill and the
// wide layout's usage windows, all from pushed Stats. Percentages carry
// `heat`, the whole percent used, which the page colors with the
// shared curve (.heat-N, colors.heat).

import { subscriptions } from '../common/subscriptions.ts'
import { titles } from '../common/titles.ts'
import { usageWindows } from '../common/usage-windows.ts'
import type { ViewState } from './view.ts'

export type StatusPart = { text: string; heat?: number }
// `path`: cut from the start when too wide, keeping the directory's name.
export type StatusGroup = { parts: StatusPart[]; path?: true; href?: string }
// The model name as a quota indicator: the shortest window's name, its
// percent used and remaining.
export type Quota = { window: string; used: number; remaining: number }
export type UsageWindow = { name: string; used: number; resets?: string }

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))
// Model-specific windows (7d_sonnet) are left out, as in /status.
const general = (plan: { windows: Record<string, number> }) => Object.keys(plan.windows).filter((name) => !/^\d+[a-z]+[-_]/.test(name))

function context(st: ViewState): StatusPart | undefined {
	let stats = st.transcript?.stats
	if (!stats?.window) return
	let percent = Math.round((stats.context ?? 0) / stats.window * 100)
	return { text: `${percent}%`, heat: clamp(percent) }
}

// None without quota data (API keys, no response yet): the name stays
// neutral rather than implying a full or empty quota.
function quota(st: ViewState): Quota | undefined {
	let plan = st.transcript?.stats?.plan
	if (!plan) return
	let all = windows(st)
	let window = usageWindows.shortest(Object.fromEntries(all.map((w) => [w.name, w.used])))
	if (window === undefined) return
	let used = all.find((w) => w.name === window)!.used
	return { window, used, remaining: 100 - used }
}

// The windows after the model name on wide layouts, shortest first;
// windows a full one outlasts are left out.
function windows(st: ViewState): UsageWindow[] {
	let plan = st.transcript?.stats?.plan
	if (!plan) return []
	let data = subscriptions.plan(plan)
	let length = (name: string) => usageWindows.minutes(name) ?? Infinity
	let out: UsageWindow[] = general(data).sort((a, b) => length(a) - length(b)).map((name) => ({ name, used: clamp(data.windows[name]!), ...(data.resets[name] && { resets: data.resets[name] }) }))
	let moot = usageWindows.moot(out)
	return out.filter((w) => !moot.has(w.name))
}

// The details dialog's facts, one group per line.
function groups(st: ViewState): StatusGroup[] {
	let t = st.transcript
	if (!t) return []
	let { meta, stats } = t
	let kilo = (n: number) => n < 1000 ? String(n) : `${Math.round(n / 1000)}k`
	let out: StatusGroup[] = [
		{ parts: [{ text: meta.id }, ...(meta.name ? [{ text: `: ${meta.name}` }] : [])] },
		{ parts: [{ text: meta.cwd }], path: true },
		{ parts: [{ text: titles.modelLabel(meta.model, stats?.effort, true) }] },
	]
	if (stats?.files) out.push({ parts: [{ text: `${stats.files} files` }], href: `/changes/${meta.id}` })
	let pct = status.context(st)
	if (stats?.window) out.push({ parts: [{ text: `${kilo(stats.context ?? 0)}/${kilo(stats.window)} (` }, pct!, { text: ')' }], href: `/context/${meta.id}` })
	else if (stats?.context) out.push({ parts: [{ text: kilo(stats.context) }], href: `/context/${meta.id}` })
	if (stats?.plan) {
		let plan = stats.plan
		let parts: StatusPart[] = [{ text: `Sub${plan.accounts > 1 ? ` ${plan.account}/${plan.accounts}` : ''}` }]
		for (let [name, percent] of Object.entries(subscriptions.plan(plan).windows)) parts.push({ text: `${parts.length === 1 ? ': ' : ', '}${name} ` }, { text: `${percent}%`, heat: clamp(percent) })
		out.push({ parts })
	}
	return out
}

export const status = { groups, context, quota, windows, reset: (at: string) => usageWindows.reset(at) }
