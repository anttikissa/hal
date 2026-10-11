import { auth, CLIENT_ID, OPENAI_CLIENT_ID, jwtClaims, type Kind } from './auth.ts'
import { clock } from './clock.ts'
import { liveFiles } from './live-file.ts'

type Entry = Record<string, any>

async function refresh(data: Entry, entry: Entry, replace: (next: Entry) => void, kind: Kind = 'anthropic'): Promise<string> {
	let res: Response
	let request = kind === 'openai' ? { client_id: OPENAI_CLIENT_ID, grant_type: 'refresh_token', refresh_token: entry.refreshToken, scope: 'openid profile email' } : { grant_type: 'refresh_token', refresh_token: entry.refreshToken, client_id: CLIENT_ID }
	try {
		res = await fetch(auth.tokenUrl(kind), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(auth.refreshTimeoutMs()),
		})
	} catch (e: any) {
		throw auth.fail(`${kind} token refresh failed: ${e?.name === 'TimeoutError' ? 'timed out' : (e?.message ?? e)}`, 'temporary')
	}
	let body: any = await res.json().catch(() => null)
	if (!res.ok) {
		let code = typeof body?.error === 'string' && /^[\w.-]{1,64}$/.test(body.error) ? ` ${body.error}` : ''
		if (typeof body?.error_description === 'string') code += ` (${body.error_description.split(entry.refreshToken).join('<redacted>').slice(0, 300).replace(/[\w.~+/=-]{24,}/g, '<redacted>')})`
		let failure: 'auth' | 'temporary' = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 ? 'auth' : 'temporary'
		throw auth.fail(`${kind} token refresh failed: HTTP ${res.status}${code}; if this persists, ${auth.logIn(kind)}`, failure)
	}
	if (!auth.usable(body?.access_token)) throw auth.fail(`${kind} token refresh returned no access token`, 'temporary')
	let accountId = jwtClaims(body.access_token)?.['https://api.openai.com/auth']?.chatgpt_account_id
	let expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600
	replace({
		...entry,
		accessToken: body.access_token,
		refreshToken: auth.usable(body.refresh_token) ? body.refresh_token : entry.refreshToken,
		expires: clock.now() + expiresIn * 1000,
		...(kind === 'openai' && auth.usable(accountId) && { accountId }),
	})
	liveFiles.save(data)
	return body.access_token
}

export const authRefresh = { refresh }
