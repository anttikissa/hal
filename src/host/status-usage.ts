// /status: one table shape for the terminal and web (both render Markdown).
// Usage normally comes from response headers; stale subscriptions can be
// refreshed from the provider's usage endpoint without sending a model turn.
import { auth, jwtClaims, type Kind } from './auth.ts'
import { clients } from './clients.ts'
import { clock } from './clock.ts'
import { limits } from './limits.ts'
import { usage, type Windows } from './usage.ts'
import { liveFiles } from './live-file.ts'
import { usageWindows } from '../common/usage-windows.ts'
import { version } from './version.ts'
import { web } from './web.ts'

type Account = ReturnType<typeof auth.all>['list'][number]
export type UsageRow = { provider: Kind; slot: string; account: string; plan?: string; error?: string; windows: Windows; apiKey: boolean }

const reset = (at: string, now = clock.now(), zone?: string): string => usageWindows.reset(at, now, zone)

function bar(percent: number): string {
	let eighths = Math.round(Math.max(0, Math.min(100, percent)) * 14 * 8 / 100)
	let whole = Math.floor(eighths / 8)
	let part = eighths % 8
	return '█'.repeat(whole) + (part ? '▏▎▍▌▋▊▉'[part - 1] : '') + '░'.repeat(14 - whole - (part ? 1 : 0))
}

function table(rows: UsageRow[], zone?: string): string {
	let groups: string[] = []
	for (let kind of ['anthropic', 'openai'] as const) {
		let accounts = rows.filter((row) => row.provider === kind)
		if (!accounts.length) continue
		let names = [...new Set(accounts.flatMap((row) => Object.keys(row.windows).filter((name) => !/^\d+[a-z]+[-_]/.test(name))))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
		let cols = names.length ? names : ['5h', '7d']
		let lines = [`${kind === 'anthropic' ? 'Anthropic' : 'OpenAI'} subscriptions:`, '', `| Slot | Account | ${cols.join(' | ')} |`, `|${Array(cols.length + 2).fill('---').join('|')}|`]
		for (let row of accounts) {
			let safe = (value: string) => value.replace(/[|<>]/g, ' ').replace(/\*/g, '\\*')
			let account = `${safe(row.account)}${row.plan ? ` (${safe(row.plan)})` : ''}${row.error ? `<br>${safe(row.error)}` : ''}`
			let cells = cols.map((name) => {
				if (row.apiKey) return 'API key'
				let w = row.windows[name]
				return w ? `${statusUsage.bar(w.used)}<br>${Math.round(w.used)}% used${w.resets ? ` (resets ${statusUsage.reset(w.resets, clock.now(), zone)})` : ''}` : '?'
			})
			lines.push(`| ${row.slot} | ${account} | ${cells.join(' | ')} |`)
		}
		groups.push(lines.join('\n'))
	}
	return groups.join('\n\n')
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
				// Already percent (0..100), unlike the header fractions.
				let v = value as { utilization?: number; resets_at?: string }
				put(key === 'five_hour' ? '5h' : `7d${key.slice('seven_day'.length)}`, v.utilization, v.resets_at)
			}
		}
	} else {
		for (let name of ['primary', 'secondary']) {
			let v = raw?.rate_limit?.[`${name}_window`]
			let seconds = v?.limit_window_seconds
			let label = seconds > 0 ? usage.span(Math.round(seconds / 60)) : name
			put(label, v?.used_percent, v?.reset_at)
		}
	}
	return out
}

// Returns 'old → new' when the account's plan changed.
async function refresh(kind: Kind, account: Account): Promise<string | undefined> {
	let { data } = auth.all(kind)
	let credential = await auth.credential(data, account, kind)
	if (credential.type !== 'token') return
	let url = kind === 'anthropic' ? 'https://api.anthropic.com/api/oauth/usage' : 'https://chatgpt.com/backend-api/wham/usage'
	let headers: Record<string, string> = { Authorization: `Bearer ${credential.value}` }
	if (kind === 'anthropic') Object.assign(headers, { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' })
	if (kind === 'openai' && credential.accountId) headers['ChatGPT-Account-ID'] = credential.accountId
	let response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
	if (!response.ok) throw new Error(`HTTP ${response.status}`)
	let raw = await response.json()
	let windows = statusUsage.payload(kind, raw)
	if (!Object.keys(windows).length) throw new Error('no windows returned')
	let store = usage.store()
	store[kind] ??= {}
	let observed = new Date(clock.now()).toISOString()
	// The endpoint lists every current window: windows it omits (an old
	// plan's) are gone, not merely unreported.
	store[kind]![account.name] = { ...Object.fromEntries(Object.entries(windows).map(([name, w]) => [name, { ...w, observed }])) }
	// Fresh usage with room in every window outranks an older skip (a 429,
	// or a refusal from before a plan change): forget it and wake waiting
	// turns to try the account. If it still fails, the skip comes back.
	if (Object.values(windows).every((w) => w.used < 100) && limits.forget(kind, account.name)) auth.state.logins++
	let email = typeof raw?.email === 'string' && raw.email.includes('@') ? raw.email : jwtClaims(credential.value)?.['https://api.openai.com/profile']?.email
	if (kind === 'anthropic' && !email && !account.entry.email && !account.name.includes('@')) {
		try {
			let profile = await fetch('https://api.anthropic.com/api/oauth/profile', { headers, signal: AbortSignal.timeout(5000) })
			if (profile.ok) email = (await profile.json())?.account?.email
		} catch { /* usage still succeeded */ }
	}
	let current = auth.all(kind).list.find((a) => a.name === account.name)?.entry ?? account.entry
	if (typeof email === 'string' && email.includes('@') && !current.email) {
		current.email = email
		if (account.name !== email) {
			store[kind]![email] = store[kind]![account.name]!
			delete store[kind]![account.name]
			for (let [key, name] of auth.state.chosen) if (key.startsWith(`${kind} `) && name === account.name) auth.state.chosen.set(key, email)
		}
	}
	let before = current.plan
	if (kind === 'openai' && typeof raw?.plan_type === 'string' && /^[\w -]{1,32}$/.test(raw.plan_type)) current.plan = raw.plan_type
	if (current.email || current.plan) liveFiles.save(data)
	if (before && current.plan && before !== current.plan) return `${before} → ${current.plan}`
}

function problem(error: unknown): { text: string; login: boolean } {
	let message = error instanceof Error ? error.message : String(error)
	let http = /HTTP (\d{3})/.exec(message)
	if (http) return { text: `HTTP ${http[1]}`, login: http[1] === '401' || http[1] === '403' }
	if (/invalid_grant|expired|rejected|no refreshToken|login/i.test(message)) return { text: 'login expired', login: true }
	if (/timeout|timed out|abort/i.test(message)) return { text: 'timed out', login: false }
	return { text: 'refresh failed', login: false }
}

function runtime(zone?: string): string {
	let started = new Date(clock.now() - process.uptime() * 1000)
	let uptime = Math.floor(process.uptime())
	let date = `${started.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone })} on ${started.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: zone })}`
	return `Runtime:\nPID: ${process.pid} · version: ${version.state.loaded ?? 'unknown'}\nStarted: ${date} (${Math.floor(uptime / 3600)}h ${Math.floor(uptime % 3600 / 60)}m ago)${web.state.server ? `\nWeb: port ${web.state.server.port}${web.state.server.port !== web.port() ? ` (preferred ${web.port()} busy)` : ''}` : ''}`
}

async function show(sessionId: string, model: string): Promise<string> {
	let rows: UsageRow[] = []
	let broken = false
	for (let kind of ['anthropic', 'openai'] as const) {
		let list: Account[]
		try { list = auth.all(kind).list } catch (e: any) {
			if (e?.message?.includes('no ' + kind + ' login')) continue
			throw e
		}
		let selected = model.startsWith(`${kind}/`) ? auth.state.chosen.get(`${kind} ${sessionId}`) ?? auth.pickAccount(kind, list, { session: sessionId })[0]?.name : undefined
		for (let [i, account] of list.entries()) {
			let apiKey = !auth.usable(account.entry.accessToken)
			let data = usage.store()[kind]?.[account.name] ?? {}
			let recent = Math.max(0, ...Object.values(data).map((w) => Date.parse(w.observed ?? '') || 0))
			let error: string | undefined
			if (!apiKey && clock.now() - recent > 60_000) {
				try {
					let changed = await statusUsage.refresh(kind, account)
					if (changed) error = `plan changed: ${changed}`
				} catch (e) {
					let failure = statusUsage.problem(e)
					error = `${failure.text} — showing cached usage`
					broken ||= failure.login
				}
			}
			let current = auth.all(kind).list[i]?.entry ?? account.entry
			let email = current.email ?? jwtClaims(current.accessToken ?? '')?.['https://api.openai.com/profile']?.email
			let name = typeof email === 'string' && email.includes('@') ? email : account.name
			let key = usage.store()[kind]?.[name] ? name : account.name
			let plan = kind === 'openai' && typeof current.plan === 'string' && /^[\w -]{1,32}$/.test(current.plan) ? current.plan : undefined
			rows.push({ provider: kind, slot: `${i + 1}/${list.length}${(account.name === selected || name === selected) ? ' *' : ''}`, account: name, plan, error, windows: apiKey ? {} : usage.windows(kind, key), apiKey })
		}
	}
	// Times show in the asking client's zone, as its status line does.
	let zone = clients.timezone(sessionId)
	return `${statusUsage.runtime(zone)}\n\n${rows.length ? statusUsage.table(rows, zone) : 'No accounts configured.'}${broken ? '\n\nTo log in again, run /login claude or /login chatgpt.' : ''}`
}

export const statusUsage = { reset, bar, table, payload, refresh, problem, runtime, show }
