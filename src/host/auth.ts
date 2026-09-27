// Anthropic credentials: this home's <home>/auth.ason (the old Hal's
// file, single-entry or array shape, copied in or written by /login
// claude: login.ts), then ANTHROPIC_API_KEY from the environment as the
// last account, so a key alone needs no file. Read through liveFile;
// an expired OAuth token is refreshed and written back to this home's
// file only, 0600. ~/.hal/auth.ason is never read or written.
//
// Errors name the file and the problem, never a credential value, and
// carry `failure` (provider.ts): 'auth' when only a human fixes it
// (log in, fix the file), 'temporary' when trying again may work,
// 'limited' (with retryAt) when every account is rate limited.
//
// Several anthropic entries are accounts, used in order: one limited
// for the model (limits.ts) or whose login is broken is skipped, so a
// 429 rotates to the next account for the same model. A login is
// broken when its refresh token is rejected (invalid_grant: typically
// a copied file where another home already rotated the token) or its
// fresh token is rejected again. Broken is remembered by a hash of the
// credentials, so it ends by itself when the file gets new ones; while
// every account is broken the session is blocked on login, watching the
// file (changed()).

import { existsSync, statSync } from 'fs'
import { clock } from './clock.ts'
import { limits } from './limits.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

export type Credential = { type: 'token' | 'api-key'; value: string; email?: string; account: string }
type Failure = 'auth' | 'temporary' | 'limited'

type Entry = Record<string, any>

// Shared with the old Hal's /login claude (login.ts).
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

// What every message asking the user to log in says.
export const LOG_IN = 'run /login claude or set ANTHROPIC_API_KEY'

function tokenUrl(): string {
	return 'https://console.anthropic.com/v1/oauth/token'
}

// Refresh this long before expiry, so a token cannot lapse mid-request.
function refreshMarginMs(): number {
	return 60_000
}

function refreshTimeoutMs(): number {
	return 30_000
}

function fail(message: string, failure: Failure = 'auth'): Error {
	return Object.assign(new Error(`${paths.display(paths.authFile())}: ${message}`), { failure })
}

// The live file for the current home; reopened if the home changes.
function store(): Entry {
	let path = paths.authFile()
	if (auth.state.store && auth.state.path === path) return auth.state.store
	auth.close()
	if (auth.state.memoPath !== path) {
		auth.state.memoPath = path
		auth.state.broken.clear()
		auth.state.stale.clear()
		auth.state.retried.clear()
	}
	if (!existsSync(path)) throw fail(`missing; ${LOG_IN}`)
	// liveFile's own errors name the file and never quote its content.
	try {
		auth.state.store = liveFiles.liveFile(path, {}, { mode: 0o600 })
	} catch (e: any) {
		throw Object.assign(e, { failure: 'auth' })
	}
	auth.state.path = path
	return auth.state.store
}

type Account = { entry: Entry; name: string; replace: (next: Entry) => void }

// Every account in order: the file's (if there is one), then the
// environment's key. Throws when there is none.
function all(): { data: Entry; list: Account[] } {
	let data = existsSync(paths.authFile()) ? auth.store() : {}
	let list = auth.accounts(data)
	let key = auth.envKey()
	if (usable(key)) list.push({ entry: { apiKey: key }, name: 'ANTHROPIC_API_KEY', replace: () => {} })
	if (!list.length) throw fail(`no anthropic login; ${LOG_IN}`)
	return { data, list }
}

// Every anthropic entry in the file holding a credential, in order.
function accounts(data: Entry): Account[] {
	let raw = data.anthropic
	if (raw === undefined) return []
	let list = Array.isArray(raw) ? raw : [raw]
	let out: Account[] = []
	for (let i = 0; i < list.length; i++) {
		let entry = list[i]
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
		if (!usable(entry.accessToken) && !usable(entry.apiKey)) continue
		let replace = Array.isArray(raw) ? (next: Entry) => (raw[i] = next) : (next: Entry) => (data.anthropic = next)
		let name = usable(entry.email) ? entry.email : `account ${i + 1}`
		out.push({ entry, name, replace })
	}
	if (!out.length) throw fail('anthropic entry has no accessToken or apiKey')
	return out
}

function usable(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0
}

// Identifies an entry's credentials without keeping them.
function fingerprint(entry: Entry): string {
	return String(Bun.hash(`${entry.refreshToken ?? ''}\n${entry.accessToken ?? ''}\n${entry.apiKey ?? ''}`))
}

// A valid anthropic credential, refreshing an expired token first, from
// the first account neither broken nor limited for `model`. Concurrent
// callers share one refresh.
async function anthropic(model?: string): Promise<Credential> {
	let { data, list } = auth.all()
	let limitedUntil = Infinity
	let problems: string[] = []
	for (let account of list) {
		let why = auth.state.broken.get(fingerprint(account.entry))
		if (why) {
			problems.push(why)
			continue
		}
		let until = model ? limits.until(limits.key(`anthropic/${model}`, account.name)) : 0
		if (until) {
			limitedUntil = Math.min(limitedUntil, until)
			continue
		}
		try {
			return await auth.credential(data, account)
		} catch (e: any) {
			if (e?.failure !== 'auth') throw e
			auth.state.broken.set(fingerprint(account.entry), e.message)
			problems.push(e.message)
		}
	}
	if (limitedUntil < Infinity) {
		throw Object.assign(fail(`every usable anthropic account is rate limited for ${model}`, 'limited'), { retryAt: limitedUntil })
	}
	throw Object.assign(new Error(problems.join('; ')), { failure: 'auth' })
}

async function credential(data: Entry, { entry, name, replace }: Account): Promise<Credential> {
	let email = typeof entry.email === 'string' ? entry.email : undefined
	let account = name
	if (!usable(entry.accessToken)) return { type: 'api-key', value: entry.apiKey, email, account }
	if (entry.expires !== undefined && typeof entry.expires !== 'number') throw fail('anthropic expires is not a number')
	let stale = auth.state.stale.has(fingerprint(entry))
	if (!stale && (entry.expires === undefined || clock.now() < entry.expires - auth.refreshMarginMs())) {
		return { type: 'token', value: entry.accessToken, email, account }
	}
	if (!usable(entry.refreshToken)) throw fail(`anthropic token ${stale ? 'rejected' : 'expired'} and there is no refreshToken; ${LOG_IN}`)
	let pending = auth.state.refreshing.get(name)
	if (!pending) {
		pending = auth.refresh(data, entry, replace).finally(() => auth.state.refreshing.delete(name))
		auth.state.refreshing.set(name, pending)
	}
	return { type: 'token', value: await pending, email, account }
}

// The API rejected the account's token (401). Refresh it once; if that
// already happened lately, the login is broken.
function rejected(name: string): void {
	let account = auth.all().list.find((a) => a.name === name)
	if (!account) return
	let fp = fingerprint(account.entry)
	let last = auth.state.retried.get(name)
	if (usable(account.entry.refreshToken) && (last === undefined || clock.now() - last > auth.retryRejectedMs())) {
		auth.state.retried.set(name, clock.now())
		auth.state.stale.add(fp)
	} else auth.state.broken.set(fp, fail(`anthropic credentials for ${name} were rejected (401); ${LOG_IN}`).message)
}

// Resolves when the credentials file changes (appears, is replaced or
// edited), a /login ends (auth.state.logins; one that failed blocks
// again at once) or `signal` aborts: what a session blocked on login
// waits for. Polls, so a missing file or directory needs no watcher;
// then reopens the file so the next call reads what is there now.
async function changed(signal?: AbortSignal): Promise<void> {
	let look = () => {
		try {
			let st = statSync(paths.authFile())
			return `${auth.state.logins}:${st.mtimeMs}:${st.size}:${st.ino}`
		} catch {
			return `${auth.state.logins}:none`
		}
	}
	let before = look()
	while (!signal?.aborted) {
		await clock.sleep(auth.pollMs(), signal)
		if (look() !== before) {
			auth.close()
			return
		}
	}
}

async function refresh(data: Entry, entry: Entry, replace: (next: Entry) => void): Promise<string> {
	let res: Response
	try {
		res = await fetch(auth.tokenUrl(), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: entry.refreshToken, client_id: CLIENT_ID }),
			signal: AbortSignal.timeout(auth.refreshTimeoutMs()),
		})
	} catch (e: any) {
		throw fail(`anthropic token refresh failed: ${e?.name === 'TimeoutError' ? 'timed out' : (e?.message ?? e)}`, 'temporary')
	}
	let body: any = await res.json().catch(() => null)
	if (!res.ok) {
		// Only the error code: descriptions may echo the refresh token.
		let code = typeof body?.error === 'string' && /^[\w.-]{1,64}$/.test(body.error) ? ` ${body.error}` : ''
		// 4xx (invalid_grant): the refresh token is spent; only a new
		// login fixes it. Anything else may pass.
		let failure: Failure = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 ? 'auth' : 'temporary'
		throw fail(`anthropic token refresh failed: HTTP ${res.status}${code}; if this persists, ${LOG_IN}`, failure)
	}
	if (!usable(body?.access_token)) throw fail('anthropic token refresh returned no access token', 'temporary')
	let expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600
	replace({
		...entry,
		accessToken: body.access_token,
		refreshToken: usable(body.refresh_token) ? body.refresh_token : entry.refreshToken,
		expires: clock.now() + expiresIn * 1000,
	})
	// Write now, so a crash cannot lose a rotated refresh token.
	liveFiles.save(data)
	return body.access_token
}

// Write pending changes and stop watching. The next call reopens.
function close(): void {
	let s = auth.state.store
	auth.state.store = null
	auth.state.path = ''
	if (s) liveFiles.close(s)
}

export const auth = {
	tokenUrl,
	refreshMarginMs,
	refreshTimeoutMs,
	// How often a session blocked on login looks at the credentials file.
	pollMs: () => 2000,
	// A rejected token is refreshed at most this often per account.
	retryRejectedMs: () => 10 * 60_000,
	// The environment's anthropic API key: the account after the file's.
	envKey: (): string | undefined => process.env.ANTHROPIC_API_KEY,
	store,
	all,
	accounts,
	anthropic,
	credential,
	rejected,
	changed,
	refresh,
	close,
	state: {
		store: null as Entry | null,
		path: '',
		// Refreshes in flight, per account, shared by concurrent callers.
		refreshing: new Map<string, Promise<string>>(),
		// The file the memory below is about; forgotten for another home.
		memoPath: '',
		// Fingerprints of broken logins, with why; of rejected tokens to refresh.
		broken: new Map<string, string>(),
		stale: new Set<string>(),
		// When each account's rejected token was last refreshed.
		retried: new Map<string, number>(),
		// Counts ended /login attempts, so blocked sessions look again.
		logins: 0,
	},
}
