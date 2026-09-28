// /status: one table shape for the terminal and web (both render Markdown).
// Usage normally comes from response headers; stale subscriptions can be
// refreshed from the provider's usage endpoint without sending a model turn.
import { auth, type Kind } from './auth.ts'
import { clock } from './clock.ts'
import { usage, type Windows } from './usage.ts'

type Account = ReturnType<typeof auth.all>['list'][number]
export type UsageRow = { provider: Kind; slot: string; account: string; windows: Windows; apiKey: boolean }

function mask(value: string): string {
	return value.replace(/^([^@])[^@]*@([^.]*)?(\..*)$/, (_all, first: string, domain: string, suffix: string) => `${first}***@${domain?.slice(0, 1) ?? ''}****${suffix}`)
}

function reset(at: string, now = clock.now()): string {
	let date = new Date(at)
	let today = new Date(now)
	let time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
	return date.toDateString() === today.toDateString() ? `today at ${time}` : `on ${date.getDate()} ${date.toLocaleString(undefined, { month: 'short' })} at ${time}`
}

function bar(percent: number): string {
	let filled = Math.round(Math.max(0, Math.min(100, percent)) / 10)
	return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

function table(rows: UsageRow[]): string {
	let names = [...new Set(rows.flatMap((row) => Object.keys(row.windows)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
	let cols = names.length ? names : ['Usage']
	let lines = [`| Provider | Slot | Account | ${cols.join(' | ')} |`, `|${Array(cols.length + 3).fill(' --- ').join('|')}|`]
	for (let row of rows) {
		let cells = cols.map((name) => {
			if (row.apiKey) return 'API key'
			let w = row.windows[name]
			return w ? `${bar(w.used)} ${Math.round(w.used)}% used${w.resets ? ` (resets ${reset(w.resets)})` : ''}` : '—'
		})
		lines.push(`| ${row.provider} | ${row.slot} | ${row.account} | ${cells.join(' | ')} |`)
	}
	return lines.join('\n')
}

// A provider response is only a cache update when it contains valid windows.
function payload(kind: Kind, raw: any): Windows {
	let out: Windows = {}
	let put = (name: string, percent: unknown, resets: unknown) => {
		if (typeof percent !== 'number' || !Number.isFinite(percent)) return
		let window: Windows[string] = { used: Math.max(0, Math.min(100, percent)) }
		if (typeof resets === 'string' && Number.isFinite(Date.parse(resets))) window.resets = new Date(resets).toISOString()
		if (typeof resets === 'number' && Number.isFinite(resets) && resets > 0) window.resets = new Date(resets * 1000).toISOString()
		out[name] = window
	}
	if (kind === 'anthropic') {
		for (let [key, value] of Object.entries(raw ?? {})) {
			let m = /^(five_hour|seven_day(?:_\w+)?)$/.exec(key)
			if (m && value && typeof value === 'object') {
				let v = value as { utilization?: number; resets_at?: string }
				put(key === 'five_hour' ? '5h' : `7d${key.slice('seven_day'.length)}`, v.utilization === undefined ? undefined : v.utilization * 100, v.resets_at)
			}
		}
	} else {
		for (let name of ['primary', 'secondary']) {
			let v = raw?.rate_limit?.[`${name}_window`]
			let seconds = v?.limit_window_seconds
			let label = seconds === 300 * 60 ? '5h' : seconds === 7 * 86400 ? '7d' : `${name}`
			put(label, v?.used_percent, v?.reset_at)
		}
	}
	return out
}

async function refresh(kind: Kind, account: Account): Promise<void> {
	let { data } = auth.all(kind)
	let credential = await auth.credential(data, account, kind)
	if (credential.type !== 'token') return
	let url = kind === 'anthropic' ? 'https://api.anthropic.com/api/oauth/usage' : 'https://chatgpt.com/backend-api/wham/usage'
	let headers: Record<string, string> = { Authorization: `Bearer ${credential.value}` }
	if (kind === 'openai' && credential.accountId) headers['ChatGPT-Account-ID'] = credential.accountId
	let response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
	if (!response.ok) throw new Error(`${kind} usage: HTTP ${response.status}`)
	let windows = statusUsage.payload(kind, await response.json())
	if (!Object.keys(windows).length) throw new Error(`${kind} usage: no windows returned`)
	let store = usage.store()
	store[kind] ??= {}
	let observed = new Date(clock.now()).toISOString()
	store[kind]![account.name] = { ...store[kind]![account.name], ...Object.fromEntries(Object.entries(windows).map(([name, w]) => [name, { ...w, observed }])) }
}

async function show(sessionId: string, model: string): Promise<string> {
	let rows: UsageRow[] = []
	let failures: string[] = []
	for (let kind of ['anthropic', 'openai'] as const) {
		let list: Account[]
		try { list = auth.all(kind).list } catch (e: any) {
			if (e?.message?.includes('no ' + kind + ' login')) continue
			throw e
		}
		let selected = model.startsWith(`${kind}/`) ? auth.state.chosen.get(`${kind} ${sessionId}`) ?? auth.order(kind, list, { session: sessionId })[0]?.name : undefined
		for (let [i, account] of list.entries()) {
			let apiKey = !auth.usable(account.entry.accessToken)
			let data = usage.store()[kind]?.[account.name] ?? {}
			let recent = Math.max(0, ...Object.values(data).map((w) => Date.parse(w.observed ?? '') || 0))
			if (!apiKey && clock.now() - recent > 60_000) {
				try { await statusUsage.refresh(kind, account) } catch (e: any) { failures.push(`${kind} ${statusUsage.mask(account.name)}: refresh failed (${e?.message ?? e}); showing cached usage`) }
			}
			rows.push({ provider: kind, slot: `${i + 1}/${list.length}${account.name === selected ? ' *' : ''}`, account: statusUsage.mask(account.name), windows: apiKey ? {} : usage.windows(kind, account.name), apiKey })
		}
	}
	return `${rows.length ? statusUsage.table(rows) : 'No accounts configured.'}${failures.length ? `\n\n${failures.join('\n')}` : ''}`
}

export const statusUsage = { mask, reset, bar, table, payload, refresh, show }
