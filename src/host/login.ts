// /login claude: the Claude subscription OAuth flow (PKCE with a pasted
// code), writing the tokens to this home's credentials file (auth.ts),
// so this home refreshes its own tokens and never rotates another
// home's refresh token away.
//
// The verifier travels as the OAuth state and comes back in the pasted
// code#state value, so nothing waits in memory between showing the URL
// and the answer (the question survives restart). Errors never quote
// the code or a token: only HTTP statuses and sanitized error codes.

import { existsSync } from 'fs'
import { auth, CLIENT_ID, type Kind } from './auth.ts'
import { limits } from './limits.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { secrets } from './secrets.ts'

type Entry = Record<string, any>

const REDIRECT = 'https://console.anthropic.com/oauth/code/callback'
const SCOPE = 'org:create_api_key user:profile user:inference'
const BAD_CODE = 'not a Claude login code; paste the whole code#state value from the page'

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// The URL to open. Anthropic's server wants its own verifier shape: 43
// characters from a 62-letter alphabet.
async function url(): Promise<string> {
	let alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
	let verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)), (b) => alphabet[b % 62]).join('')
	let challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
	let u = new URL(login.authorizeUrl)
	let params = { code: 'true', client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPE }
	for (let [k, v] of Object.entries(params)) u.searchParams.set(k, v)
	u.searchParams.set('code_challenge', challenge)
	u.searchParams.set('code_challenge_method', 'S256')
	u.searchParams.set('state', verifier)
	return u.toString()
}

// Exchanges the pasted code#state for tokens and saves them. Returns
// the account's email, if the profile gave one.
async function finish(pasted: string): Promise<string | undefined> {
	try {
		let [code, verifier, extra] = pasted.trim().split('#')
		if (!code || extra !== undefined || !/^[A-Za-z0-9]{43}$/.test(verifier ?? '')) throw new Error(BAD_CODE)
		let res = await fetch(auth.tokenUrl(), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ code, state: verifier, grant_type: 'authorization_code', client_id: CLIENT_ID, redirect_uri: REDIRECT, code_verifier: verifier }),
			signal: AbortSignal.timeout(auth.refreshTimeoutMs()),
		})
		let body: any = await res.json().catch(() => null)
		if (!res.ok) {
			let error = typeof body?.error === 'string' && /^[\w.-]{1,64}$/.test(body.error) ? ` ${body.error}` : ''
			throw new Error(`Claude login failed: HTTP ${res.status}${error}`)
		}
		if (typeof body?.access_token !== 'string' || typeof body?.refresh_token !== 'string') throw new Error('Claude login failed: no tokens in the response')
		let email = await login.email(body.access_token)
		let expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600
		login.save({ accessToken: body.access_token, refreshToken: body.refresh_token, expires: Date.now() + expiresIn * 1000, ...(email && { email }) })
		return email
	} finally {
		// A session blocked on login tries again: it works now, or blocks
		// again at once.
		auth.state.logins++
	}
}

// The account's email, which names it in the file and in messages.
async function email(token: string): Promise<string | undefined> {
	try {
		let res = await fetch(login.profileUrl, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
		if (!res.ok) return undefined
		let data: any = await res.json()
		let found = data?.account?.email
		return typeof found === 'string' && found ? found : undefined
	} catch {
		return undefined
	}
}

// Adds the login to this home's credentials file as a `kind` account,
// replacing the entry with the same identity (anthropic: email, openai:
// ChatGPT accountId); creates the file (0600) if there is none.
function save(entry: Entry, kind: Kind = 'anthropic'): void {
	let path = paths.authFile()
	let created = !existsSync(path)
	let data: Entry = created ? secrets.file(path, {}, { watch: false }) : auth.store()
	let old = data[kind]
	let list: Entry[] = old === undefined ? [] : Array.isArray(old) ? old : [old]
	let id = kind === 'openai' ? 'accountId' : 'email'
	let same = entry[id] ? list.findIndex((e) => e?.[id] === entry[id]) : -1
	if (same >= 0) list[same] = { ...list[same], ...entry }
	else list.push(entry)
	data[kind] = list.length === 1 ? list[0] : list
	liveFiles.save(data)
	if (created) liveFiles.close(data)
	// The name auth.all gives this account; its old limits no longer hold.
	let i = same >= 0 ? same : list.length - 1
	let email = list[i]?.email
	limits.forget(kind, auth.usable(email) ? email : `account ${i + 1}`)
}

export const login = {
	authorizeUrl: 'https://claude.ai/oauth/authorize',
	profileUrl: 'https://api.anthropic.com/api/oauth/profile',
	url,
	finish,
	email,
	save,
}
