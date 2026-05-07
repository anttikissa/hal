// OAuth login flows for Anthropic (Claude) and OpenAI (ChatGPT).
//
// Anthropic: PKCE → user opens URL → pastes code from redirect.
//   Two-step: startAnthropic() returns URL; finishAnthropic(code) exchanges and saves.
//   The PKCE verifier is held in module state between the two calls.
// OpenAI: PKCE → user opens URL → localhost:1455 callback catches code automatically.
//   Single-step: loginOpenai() resolves once tokens are saved or it times out.

import { createServer } from 'http'
import { auth } from './auth.ts'
import { liveFiles } from './utils/live-file.ts'

const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const ANTHROPIC_REDIRECT = 'https://console.anthropic.com/oauth/code/callback'
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const ANTHROPIC_AUTHORIZE = 'https://claude.ai/oauth/authorize'
const ANTHROPIC_PROFILE = 'https://api.anthropic.com/api/oauth/profile'
const ANTHROPIC_SCOPE = 'org:create_api_key user:profile user:inference'

const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OPENAI_AUTHORIZE = 'https://auth.openai.com/oauth/authorize'
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const OPENAI_REDIRECT = 'http://localhost:1455/auth/callback'
const OPENAI_CALLBACK_PORT = 1455

// Pending Anthropic flow: holds PKCE verifier between /login anthropic (start)
// and /login anthropic <code> (finish).
const state: { anthropicPending: { verifier: string } | null } = {
	anthropicPending: null,
}

// Random base64url string of given byte length.
function randomB64Url(byteLen: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(byteLen))
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256B64Url(input: string): Promise<string> {
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
	return btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ── Anthropic ──

async function startAnthropic(): Promise<{ url: string }> {
	// Anthropic's verifier format is bespoke (43 chars from a 62-char alphabet); their
	// auth server validates this length so we keep the original derivation.
	const bytes = crypto.getRandomValues(new Uint8Array(43))
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
	const verifier = Array.from(bytes).map((b) => alphabet[b % 62]).join('')
	const challenge = await sha256B64Url(verifier)
	state.anthropicPending = { verifier }

	const url = new URL(ANTHROPIC_AUTHORIZE)
	url.searchParams.set('code', 'true')
	url.searchParams.set('client_id', ANTHROPIC_CLIENT_ID)
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('redirect_uri', ANTHROPIC_REDIRECT)
	url.searchParams.set('scope', ANTHROPIC_SCOPE)
	url.searchParams.set('code_challenge', challenge)
	url.searchParams.set('code_challenge_method', 'S256')
	// Anthropic returns "code#state" on the callback page; we send verifier as state.
	url.searchParams.set('state', verifier)
	return { url: url.toString() }
}

async function finishAnthropic(rawCode: string): Promise<{ email?: string }> {
	if (!state.anthropicPending) {
		throw new Error('No pending Anthropic login. Run /login anthropic first.')
	}
	const verifier = state.anthropicPending.verifier
	const [authCode, returnedState] = rawCode.trim().split('#')

	const res = await fetch(ANTHROPIC_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			code: authCode,
			state: returnedState,
			grant_type: 'authorization_code',
			client_id: ANTHROPIC_CLIENT_ID,
			redirect_uri: ANTHROPIC_REDIRECT,
			code_verifier: verifier,
		}),
	})
	if (!res.ok) {
		throw new Error(`Token exchange failed: ${res.status} ${await res.text().catch(() => '')}`)
	}
	const { access_token, refresh_token, expires_in } = await res.json() as any
	state.anthropicPending = null

	// Fetch profile so we can store email alongside tokens for /status display.
	const email = await fetchAnthropicEmail(access_token)

	saveAuth('anthropic', {
		accessToken: access_token,
		refreshToken: refresh_token,
		expires: Date.now() + expires_in * 1000,
		...(email ? { email } : {}),
	})
	return { email }
}

async function fetchAnthropicEmail(accessToken: string): Promise<string | undefined> {
	try {
		const res = await fetch(ANTHROPIC_PROFILE, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
			},
			signal: AbortSignal.timeout(5_000),
		})
		if (!res.ok) return
		const data = await res.json() as any
		return data?.account?.email || data?.account?.display_name || undefined
	} catch { return }
}

// ── OpenAI ──

async function loginOpenai(onProgress?: (msg: string) => void): Promise<{ accountId?: string }> {
	const verifier = randomB64Url(32)
	const challenge = await sha256B64Url(verifier)
	const flowState = randomB64Url(16)

	const authUrl = new URL(OPENAI_AUTHORIZE)
	authUrl.searchParams.set('response_type', 'code')
	authUrl.searchParams.set('client_id', OPENAI_CLIENT_ID)
	authUrl.searchParams.set('redirect_uri', OPENAI_REDIRECT)
	authUrl.searchParams.set('scope', process.env.OPENAI_OAUTH_SCOPE ?? 'openid profile email offline_access')
	authUrl.searchParams.set('code_challenge', challenge)
	authUrl.searchParams.set('code_challenge_method', 'S256')
	authUrl.searchParams.set('state', flowState)
	authUrl.searchParams.set('id_token_add_organizations', 'true')
	authUrl.searchParams.set('codex_cli_simplified_flow', 'true')
	authUrl.searchParams.set('originator', process.env.OPENAI_ORIGINATOR ?? 'pi')

	onProgress?.(`Open this URL to log in:\n${authUrl}\n\nWaiting for callback on ${OPENAI_REDIRECT}...`)

	// Try to open browser automatically. If this fails the user can still copy the URL.
	tryOpenBrowser(authUrl.toString())

	const code = await awaitOpenaiCallback(flowState)

	const tokenRes = await fetch(OPENAI_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: OPENAI_CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: OPENAI_REDIRECT,
		}),
	})
	if (!tokenRes.ok) {
		throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text().catch(() => '')}`)
	}
	const { access_token, refresh_token, expires_in } = await tokenRes.json() as any
	if (!access_token || !refresh_token) throw new Error('Token response missing required fields')

	const accountId = decodeJwt(access_token)?.['https://api.openai.com/auth']?.chatgpt_account_id ?? null

	saveAuth('openai', {
		accessToken: access_token,
		refreshToken: refresh_token,
		expires: Date.now() + (expires_in ?? 3600) * 1000,
		...(accountId ? { accountId } : {}),
	})
	return { accountId }
}

function awaitOpenaiCallback(expectedState: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const server = createServer((req, res) => {
			try {
				const reqUrl = new URL(req.url || '', 'http://localhost')
				if (reqUrl.pathname !== '/auth/callback') {
					res.statusCode = 404; res.end('Not found'); return
				}
				if (reqUrl.searchParams.get('state') !== expectedState) {
					res.statusCode = 400; res.end('State mismatch'); return
				}
				const oauthError = reqUrl.searchParams.get('error')
				if (oauthError) {
					const desc = reqUrl.searchParams.get('error_description') || ''
					res.statusCode = 400; res.end(`OAuth error: ${oauthError}`)
					server.close()
					reject(new Error(`OAuth error: ${oauthError}${desc ? ` (${desc})` : ''}`))
					return
				}
				const code = reqUrl.searchParams.get('code')
				if (!code) { res.statusCode = 400; res.end('Missing authorization code'); return }
				res.statusCode = 200
				res.setHeader('Content-Type', 'text/html')
				res.end('<html><body><p>Authentication successful! You can close this tab.</p></body></html>')
				server.close()
				resolve(code)
			} catch (e: any) {
				res.statusCode = 500; res.end('Internal error')
				reject(e)
			}
		})
		server.listen(OPENAI_CALLBACK_PORT, '127.0.0.1')
		server.on('error', (err: any) => {
			if (err.code === 'EADDRINUSE') reject(new Error(`Port ${OPENAI_CALLBACK_PORT} already in use`))
			else reject(err)
		})
		// 10 minute window for the user to complete the browser flow.
		setTimeout(() => { server.close(); reject(new Error('Login timed out (10min)')) }, 600_000)
	})
}

function decodeJwt(token: string): any {
	try {
		const parts = token.split('.')
		if (parts.length !== 3) return null
		return JSON.parse(atob(parts[1]!))
	} catch { return null }
}

function tryOpenBrowser(url: string): void {
	try {
		Bun.spawn(['open', url], { stdout: 'ignore', stderr: 'ignore' })
	} catch {}
}

// Persist tokens. Overwrites the existing single entry for now; multi-account add
// will land in a follow-up. We go through auth.store() so the in-memory cache and
// liveFile watcher both stay consistent.
function saveAuth(provider: 'anthropic' | 'openai', entry: Record<string, any>): void {
	const s = auth.store()
	const existing = s[provider]
	if (Array.isArray(existing) && existing.length > 0) {
		// Merge into first entry, preserving extra fields not set by the new login.
		existing[0] = { ...existing[0], ...entry }
		s[provider] = existing
	} else {
		s[provider] = { ...(existing ?? {}), ...entry }
	}
	liveFiles.save(s)
}

export const authLogin = {
	state,
	startAnthropic,
	finishAnthropic,
	loginOpenai,
}
