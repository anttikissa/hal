// Anthropic credentials, copied by the user into <home>/auth.ason (the
// old Hal's file, single-entry or array shape). Read through liveFile;
// an expired OAuth token is refreshed and written back to this copy
// only, 0600. ~/.hal/auth.ason is never read or written.
//
// Errors name the file and the problem, never a credential value.

import { existsSync } from 'fs'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

export type Credential = { type: 'token' | 'api-key'; value: string; email?: string }

type Entry = Record<string, any>

// Shared with the old Hal's /login claude.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

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

function fail(message: string): Error {
	return new Error(`${paths.display(paths.authFile())}: ${message}`)
}

// The live file for the current home; reopened if the home changes.
function store(): Entry {
	let path = paths.authFile()
	if (auth.state.store && auth.state.path === path) return auth.state.store
	auth.close()
	if (!existsSync(path)) throw fail('missing; copy your credentials there to use anthropic')
	// liveFile's own errors name the file and never quote its content.
	auth.state.store = liveFiles.liveFile(path, {}, { mode: 0o600 })
	auth.state.path = path
	return auth.state.store
}

// The anthropic entry to use and a function that replaces it on disk.
function pick(data: Entry): { entry: Entry; replace: (next: Entry) => void } {
	let raw = data.anthropic
	if (raw === undefined) throw fail('no anthropic credentials')
	let list = Array.isArray(raw) ? raw : [raw]
	for (let i = 0; i < list.length; i++) {
		let entry = list[i]
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
		if (!usable(entry.accessToken) && !usable(entry.apiKey)) continue
		let replace = Array.isArray(raw) ? (next: Entry) => (raw[i] = next) : (next: Entry) => (data.anthropic = next)
		return { entry, replace }
	}
	throw fail('anthropic entry has no accessToken or apiKey')
}

function usable(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0
}

// A valid anthropic credential, refreshing an expired token first.
// Concurrent callers share one refresh.
async function anthropic(): Promise<Credential> {
	let data = auth.store()
	let { entry, replace } = pick(data)
	let email = typeof entry.email === 'string' ? entry.email : undefined
	if (!usable(entry.accessToken)) return { type: 'api-key', value: entry.apiKey, email }
	if (entry.expires !== undefined && typeof entry.expires !== 'number') throw fail('anthropic expires is not a number')
	if (entry.expires === undefined || Date.now() < entry.expires - auth.refreshMarginMs()) {
		return { type: 'token', value: entry.accessToken, email }
	}
	if (!usable(entry.refreshToken)) throw fail('anthropic token expired and there is no refreshToken; log in again')
	auth.state.refreshing ??= auth.refresh(data, entry, replace).finally(() => (auth.state.refreshing = null))
	return { type: 'token', value: await auth.state.refreshing, email }
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
		throw fail(`anthropic token refresh failed: ${e?.name === 'TimeoutError' ? 'timed out' : (e?.message ?? e)}`)
	}
	let body: any = await res.json().catch(() => null)
	if (!res.ok) {
		// Only the error code: descriptions may echo the refresh token.
		let code = typeof body?.error === 'string' && /^[\w.-]{1,64}$/.test(body.error) ? ` ${body.error}` : ''
		throw fail(`anthropic token refresh failed: HTTP ${res.status}${code}; log in again if this persists`)
	}
	if (!usable(body?.access_token)) throw fail('anthropic token refresh returned no access token')
	let expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600
	replace({
		...entry,
		accessToken: body.access_token,
		refreshToken: usable(body.refresh_token) ? body.refresh_token : entry.refreshToken,
		expires: Date.now() + expiresIn * 1000,
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
	store,
	anthropic,
	refresh,
	close,
	state: { store: null as Entry | null, path: '', refreshing: null as Promise<string> | null },
}
