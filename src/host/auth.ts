// Anthropic and OpenAI credentials: this home's <home>/auth.ason (the
// old Hal's file, single-entry or array shape per provider, copied in or
// written by /login claude or /login chatgpt: login.ts, login-chatgpt.ts),
// then ANTHROPIC_API_KEY or OPENAI_API_KEY from the environment as the
// last account, so a key alone needs no file. Read through liveFile;
// an expired OAuth token is refreshed and written back to this home's
// file only, 0600. ~/.hal/auth.ason is never read or written.
//
// Errors name the file and the problem, never a credential value, and
// carry `failure` (provider.ts): 'auth' when only a human fixes it
// (log in, fix the file), 'temporary' when trying again may work,
// 'limited' (with retryAt) when every account is rate limited.
//
// Several entries of a provider are accounts: subscriptions (OAuth
// tokens) ranked by provider-wide usage, then API keys in file order,
// the environment's last. A key is paid per token, so it is used only
// while no subscription is usable (auth.fallback tells the session so);
// a key that runs out of credits is set aside like a broken login
// (auth.spent). A turn stays on one account until limited
// for the model (limits.ts) or its login breaks, so a 429 rotates. A
// login is broken when its refresh token is rejected (invalid_grant: typically
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
import { usage } from './usage.ts'

// `accountId`: the ChatGPT account an OpenAI entry was saved with.
export type Credential = { type: 'token' | 'api-key'; value: string; email?: string; account: string; accountId?: string }
type Failure = 'auth' | 'temporary' | 'limited'
// The providers whose logins live in the credentials file.
export type Kind = 'anthropic' | 'openai'

type Entry = Record<string, any>

// Shared with the old Hal's /login claude (login.ts).
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
// The Codex CLI's, which the old Hal's /login chatgpt used too.
export const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

// What every message asking the user to log in says.
export const LOG_IN = 'run /login claude or set ANTHROPIC_API_KEY'
const LOG_INS: Record<Kind, string> = { anthropic: LOG_IN, openai: 'run /login chatgpt or set OPENAI_API_KEY' }
const ENV: Record<Kind, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' }

function tokenUrl(kind: Kind = 'anthropic'): string {
	return kind === 'openai' ? 'https://auth.openai.com/oauth/token' : 'https://console.anthropic.com/v1/oauth/token'
}

// A JWT's claims (OpenAI tokens carry the ChatGPT account and scopes);
// null if it is not one. Never verified: only read for routing.
export function jwtClaims(token: string): Record<string, any> | null {
	try {
		let part = token.split('.')[1]!
		let v = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')))
		return v && typeof v === 'object' ? v : null
	} catch {
		return null
	}
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
		auth.state.chosen.clear()
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

// Every account of `kind` in order: the file's (if there is one), then
// the environment's key. Throws when there is none.
function all(kind: Kind = 'anthropic'): { data: Entry; list: Account[] } {
	let data = existsSync(paths.authFile()) ? auth.store() : {}
	let list = auth.accounts(data, kind)
	let key = auth.envKey(kind)
	if (usable(key)) list.push({ entry: { apiKey: key }, name: ENV[kind], replace: () => {} })
	if (!list.length) throw fail(`no ${kind} login; ${LOG_INS[kind]}`)
	return { data, list }
}

// Every entry of `kind` in the file holding a credential, in order.
function accounts(data: Entry, kind: Kind = 'anthropic'): Account[] {
	let raw = data[kind]
	if (raw === undefined) return []
	let list = Array.isArray(raw) ? raw : [raw]
	let out: Account[] = []
	for (let i = 0; i < list.length; i++) {
		let entry = list[i]
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
		if (!usable(entry.accessToken) && !usable(entry.apiKey)) continue
		let replace = Array.isArray(raw) ? (next: Entry) => (raw[i] = next) : (next: Entry) => (data[kind] = next)
		let name = usable(entry.email) ? entry.email : `account ${i + 1}`
		out.push({ entry, name, replace })
	}
	if (!out.length) throw fail(`${kind} entry has no accessToken or apiKey`)
	return out
}

function usable(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0
}

// Identifies an entry's credentials without keeping them.
function fingerprint(entry: Entry): string {
	return String(Bun.hash(`${entry.refreshToken ?? ''}\n${entry.accessToken ?? ''}\n${entry.apiKey ?? ''}`))
}

// Whom a request is for: a session stays on the account it used last
// (the prompt cache is per account) until that one is limited or
// broken. Re-picking the least used every turn would flip between
// evenly used accounts, since the one just used is then the busier.
// Kept in memory only: a restart may pick again.
export type For = { session?: string }

// A subscription login, as opposed to a pay-per-token API key.
const subscription = (a: Account): boolean => usable(a.entry.accessToken)

// One replaceable account chooser for local.ts. Its default ranks the
// subscriptions by provider-wide usage, retaining the session's chosen
// one first for its prompt cache, then the API keys in order: a key has
// no usage windows, so ranked with them it would always look least used.
function pickAccount(kind: Kind, list: Account[], who: For = {}): Account[] {
	let out = usage.order(kind, list.filter(subscription), (a) => a.name)
	let mine = who.session ? auth.state.chosen.get(`${kind} ${who.session}`) : undefined
	let i = out.findIndex((a) => a.name === mine)
	if (i > 0) out.unshift(...out.splice(i, 1))
	return [...out, ...list.filter((a) => !subscription(a))]
}

// A valid credential of `kind`, refreshing an expired token first, from
// the first account (in order()) neither broken nor limited for
// `model`. Concurrent callers share one refresh.
async function pick(kind: Kind, model?: string, who: For = {}): Promise<Credential> {
	let { data, list } = auth.all(kind)
	list = auth.pickAccount(kind, list, who)
	let limitedUntil = Infinity
	let problems: string[] = []
	// Why each subscription passed over was, for the fallback notice.
	let skipped: string[] = []
	for (let account of list) {
		let why = auth.state.broken.get(fingerprint(account.entry))
		if (why) {
			problems.push(why)
			if (subscription(account)) skipped.push(`${account.name}: ${why}`)
			continue
		}
		let until = model ? limits.until(limits.key(`${kind}/${model}`, account.name)) : 0
		if (until) {
			limitedUntil = Math.min(limitedUntil, until)
			if (subscription(account)) skipped.push(`${account.name}: rate limited until ${new Date(until).toTimeString().slice(0, 5)}`)
			continue
		}
		try {
			let cred = await auth.credential(data, account, kind)
			if (who.session) {
				let key = `${kind} ${who.session}`
				let before = auth.state.chosen.get(key)
				auth.state.chosen.set(key, account.name)
				if (cred.type === 'api-key' && before !== account.name && skipped.length) {
					// A notice that cannot be written must not cost the request.
					try { auth.fallback(who.session, `using ${account.name}, a paid API key: no ${kind} subscription is usable (${skipped.join('; ')})`) } catch {}
				}
			}
			return cred
		} catch (e: any) {
			if (e?.failure !== 'auth') throw e
			auth.state.broken.set(fingerprint(account.entry), e.message)
			problems.push(e.message)
		}
	}
	if (limitedUntil < Infinity) {
		throw Object.assign(fail(`every usable ${kind} account is rate limited for ${model}`, 'limited'), { retryAt: limitedUntil })
	}
	throw Object.assign(new Error(problems.join('; ')), { failure: 'auth' })
}

// Until when (epoch ms) every account that could run `modelId` is rate
// limited; 0 if one is free now. Tells spawn and inspect which models
// would only wait. A provider without accounts has one key per model.
function limitedUntil(modelId: string): number {
	let kind = modelId.split('/')[0]
	let names: string[] = []
	if (kind === 'anthropic' || kind === 'openai') {
		try { names = auth.all(kind).list.map((a) => a.name) } catch {} // no login: the turn reports that
	}
	// An account is out until its recorded 429 ends or, when a usage
	// window it shares across models is spent, until that window resets.
	let spent = (n: string) => {
		let t = usage.tightest(kind, n)
		return t.used >= 100 && Number.isFinite(t.resets) ? t.resets : 0
	}
	let until = names.length
		? names.map((n) => Math.max(limits.until(limits.key(modelId, n)), spent(n)))
		: [limits.until(limits.key(modelId))]
	return until.includes(0) ? 0 : Math.min(...until)
}

async function credential(data: Entry, { entry, name, replace }: Account, kind: Kind = 'anthropic'): Promise<Credential> {
	let email = typeof entry.email === 'string' ? entry.email : undefined
	let base = { email, account: name, ...(usable(entry.accountId) && { accountId: entry.accountId }) }
	if (!usable(entry.accessToken)) return { type: 'api-key', value: entry.apiKey, ...base }
	if (entry.expires !== undefined && typeof entry.expires !== 'number') throw fail(`${kind} expires is not a number`)
	let stale = auth.state.stale.has(fingerprint(entry))
	if (!stale && (entry.expires === undefined || clock.now() < entry.expires - auth.refreshMarginMs())) {
		return { type: 'token', value: entry.accessToken, ...base }
	}
	if (!usable(entry.refreshToken)) throw fail(`${kind} token ${stale ? 'rejected' : 'expired'} and there is no refreshToken; ${LOG_INS[kind]}`)
	let key = `${kind}:${name}`
	let pending = auth.state.refreshing.get(key)
	if (!pending) {
		pending = auth.refresh(data, entry, replace, kind).finally(() => auth.state.refreshing.delete(key))
		auth.state.refreshing.set(key, pending)
	}
	return { type: 'token', value: await pending, ...base }
}

// The API rejected the account's token (401). Refresh it once; if that
// already happened lately, the login is broken.
function rejected(name: string, kind: Kind = 'anthropic'): void {
	let account = auth.all(kind).list.find((a) => a.name === name)
	if (!account) return
	let fp = fingerprint(account.entry)
	let key = `${kind}:${name}`
	let last = auth.state.retried.get(key)
	if (usable(account.entry.refreshToken) && (last === undefined || clock.now() - last > auth.retryRejectedMs)) {
		auth.state.retried.set(key, clock.now())
		auth.state.stale.add(fp)
	} else auth.state.broken.set(fp, fail(`${kind} credentials for ${name} were rejected (401); ${LOG_INS[kind]}`).message)
}

// The provider says the account has no credits left (a paid key, out of
// money): set it aside like a broken login, until its entry changes.
function spent(name: string, kind: Kind = 'anthropic'): void {
	let account = auth.all(kind).list.find((a) => a.name === name)
	if (account) auth.state.broken.set(fingerprint(account.entry), `${name} has no credits left`)
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
		await clock.sleep(auth.pollMs, signal)
		if (look() !== before) {
			auth.close()
			return
		}
	}
}

async function refresh(data: Entry, entry: Entry, replace: (next: Entry) => void, kind: Kind = 'anthropic'): Promise<string> {
	let res: Response
	// OpenAI's is the Codex CLI's refresh request.
	let request = kind === 'openai' ? { client_id: OPENAI_CLIENT_ID, grant_type: 'refresh_token', refresh_token: entry.refreshToken, scope: 'openid profile email' } : { grant_type: 'refresh_token', refresh_token: entry.refreshToken, client_id: CLIENT_ID }
	try {
		res = await fetch(auth.tokenUrl(kind), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(auth.refreshTimeoutMs()),
		})
	} catch (e: any) {
		throw fail(`${kind} token refresh failed: ${e?.name === 'TimeoutError' ? 'timed out' : (e?.message ?? e)}`, 'temporary')
	}
	let body: any = await res.json().catch(() => null)
	if (!res.ok) {
		// Only the error code: descriptions may echo the refresh token.
		let code = typeof body?.error === 'string' && /^[\w.-]{1,64}$/.test(body.error) ? ` ${body.error}` : ''
		// 4xx (invalid_grant): the refresh token is spent; only a new
		// login fixes it. Anything else may pass.
		let failure: Failure = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 ? 'auth' : 'temporary'
		throw fail(`${kind} token refresh failed: HTTP ${res.status}${code}; if this persists, ${LOG_INS[kind]}`, failure)
	}
	if (!usable(body?.access_token)) throw fail(`${kind} token refresh returned no access token`, 'temporary')
	let accountId = jwtClaims(body.access_token)?.['https://api.openai.com/auth']?.chatgpt_account_id
	let expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600
	replace({
		...entry,
		accessToken: body.access_token,
		refreshToken: usable(body.refresh_token) ? body.refresh_token : entry.refreshToken,
		expires: clock.now() + expiresIn * 1000,
		...(kind === 'openai' && usable(accountId) && { accountId }),
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

// The Serper API key (the google tool): the credentials file's
// serper.apiKey, else SERPER_API_KEY; undefined when neither is set.
function serperKey(): string | undefined {
	let entry = existsSync(paths.authFile()) ? (auth.store().serper as Entry | undefined) : undefined
	let key = entry && typeof entry === 'object' ? entry.apiKey : undefined
	return auth.usable(key) ? key : process.env.SERPER_API_KEY || undefined
}

export const auth = {
	tokenUrl,
	serperKey,
	usable,
	refreshMarginMs,
	refreshTimeoutMs,
	// How often a session blocked on login looks at the credentials file.
	pollMs: 2000,
	// A rejected token is refreshed at most this often per account.
	retryRejectedMs: 10 * 60_000,
	// The environment's API key: the account after the file's.
	envKey: (kind: Kind = 'anthropic'): string | undefined => process.env[ENV[kind]],
	logIn: (kind: Kind): string => LOG_INS[kind],
	store,
	all,
	accounts,
	pickAccount,
	limitedUntil,
	pick,
	anthropic: (model?: string, who?: For) => auth.pick('anthropic', model, who),
	openai: (model?: string, who?: For) => auth.pick('openai', model, who),
	credential,
	rejected,
	spent,
	// Tells session `id` it now runs on a paid key; slash.ts writes it
	// into the transcript.
	fallback: (_id: string, _text: string): void => {},
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
		// "kind session" -> the account the session's turn is on.
		chosen: new Map<string, string>(),
		// Counts ended /login attempts, so blocked sessions look again.
		logins: 0,
	},
}
