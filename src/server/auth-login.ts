// OAuth login flows for Anthropic (Claude) and OpenAI (ChatGPT).
//
// Anthropic: PKCE → user opens URL → pastes the returned code#state. The
// verifier is the returned state, so finishing survives a process restart.
// OpenAI: PKCE → the regular web server callback catches the code automatically.

import { auth } from './auth.ts'
import { liveFiles } from '../utils/live-file.ts'
import { webUpload } from './web-upload.ts'
const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const ANTHROPIC_REDIRECT = 'https://console.anthropic.com/oauth/code/callback'
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const ANTHROPIC_AUTHORIZE = 'https://claude.ai/oauth/authorize'
const ANTHROPIC_PROFILE = 'https://api.anthropic.com/api/oauth/profile'
const ANTHROPIC_SCOPE = 'org:create_api_key user:profile user:inference'

const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OPENAI_AUTHORIZE = 'https://auth.openai.com/oauth/authorize'
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'

type OpenaiCallback = {
	state: string
	resolve: (code: string) => void
	reject: (error: Error) => void
	timeout: ReturnType<typeof setTimeout>
}

const state: { openaiCallback: OpenaiCallback | null } = {
	openaiCallback: null,
}

function openaiRedirectUri(): string {
	const hostname = webUpload.config.hostname.trim()
	// OAuth redirects are credentials-bearing URLs. Accept only a hostname so a
	// malformed setting cannot turn it into an arbitrary URL or inject a path.
	if (!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(hostname)) {
		throw new Error('Set web.hostname to this host’s public DNS name, for example hal.kissa.dev')
	}
	return `https://${hostname}/auth/callback`
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
	const value = rawCode.trim()
	const separator = value.indexOf('#')
	if (separator <= 0 || separator !== value.lastIndexOf('#')) throw new Error('Invalid Claude login code. Paste the returned code#state value.')
	const authCode = value.slice(0, separator)
	const verifier = value.slice(separator + 1)
	if (!/^[A-Za-z0-9]{43}$/.test(verifier)) throw new Error('Invalid Claude login code. Paste the returned code#state value.')

	const res = await fetch(ANTHROPIC_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			code: authCode,
			state: verifier,
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
	const redirectUri = openaiRedirectUri()

	const authUrl = new URL(OPENAI_AUTHORIZE)
	authUrl.searchParams.set('response_type', 'code')
	authUrl.searchParams.set('client_id', OPENAI_CLIENT_ID)
	authUrl.searchParams.set('redirect_uri', redirectUri)
	authUrl.searchParams.set('scope', process.env.OPENAI_OAUTH_SCOPE ?? 'openid profile email offline_access')
	authUrl.searchParams.set('code_challenge', challenge)
	authUrl.searchParams.set('code_challenge_method', 'S256')
	authUrl.searchParams.set('state', flowState)
	authUrl.searchParams.set('id_token_add_organizations', 'true')
	authUrl.searchParams.set('codex_cli_simplified_flow', 'true')
	// Identify ourselves rather than borrowing another client's name. The authorize endpoint
	// accepts any value here (probed); the client_id is what actually selects the OAuth app.
	authUrl.searchParams.set('originator', process.env.OPENAI_ORIGINATOR ?? 'hal')

	// Register before exposing the authorization URL: a fast browser redirect must not
	// arrive before there is a flow state for the web server to correlate it with.
	const callback = awaitOpenaiCallback(flowState)
	onProgress?.(`Open this URL to log in:\n${authUrl}\n\nWaiting for callback on ${redirectUri}...`)

	// Try to open browser automatically. If this fails the user can still copy the URL.
	tryOpenBrowser(authUrl.toString())

	const code = await callback

	const tokenRes = await fetch(OPENAI_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: OPENAI_CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
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

function completeOpenaiCallback(callback: OpenaiCallback, result: { code?: string; error?: Error }): void {
	if (state.openaiCallback !== callback) return
	clearTimeout(callback.timeout)
	state.openaiCallback = null
	if (result.error) callback.reject(result.error)
	else callback.resolve(result.code!)
}

function awaitOpenaiCallback(expectedState: string): Promise<string> {
	if (state.openaiCallback) return Promise.reject(new Error('ChatGPT login is already in progress'))
	return new Promise<string>((resolve, reject) => {
		const callback = {
			state: expectedState,
			resolve,
			reject,
			timeout: setTimeout(() => {
				completeOpenaiCallback(callback, { error: new Error('Login timed out (10min)') })
			}, 600_000),
		}
		state.openaiCallback = callback
	})
}

function callbackResponse(body: string, status: number): Response {
	return new Response(body, {
		status,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'referrer-policy': 'no-referrer',
		},
	})
}

function handleOpenaiCallback(request: Request): Response {
	const callback = state.openaiCallback
	const url = new URL(request.url)
	if (!callback || url.searchParams.get('state') !== callback.state) return callbackResponse('State mismatch', 400)

	const oauthError = url.searchParams.get('error')
	if (oauthError) {
		const description = url.searchParams.get('error_description')
		const detail = description ? ` (${description})` : ''
		completeOpenaiCallback(callback, { error: new Error(`OAuth error: ${oauthError}${detail}`) })
		return callbackResponse('OAuth login failed. You can close this tab.', 400)
	}

	const code = url.searchParams.get('code')
	if (!code) return callbackResponse('Missing authorization code', 400)
	completeOpenaiCallback(callback, { code })
	return callbackResponse('<html><body><p>Authentication successful! You can close this tab.</p></body></html>', 200)
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

// Persist new tokens without discarding separately authenticated accounts. OpenAI's
// JWT accountId and Anthropic's profile email are their respective stable identities.
function saveAuth(provider: 'anthropic' | 'openai', entry: Record<string, any>): void {
	const s = auth.store()
	const existing = s[provider]
	const identityField = provider === 'openai' ? 'accountId' : 'email'
	const identity = entry[identityField]
	const hasIdentity = typeof identity === 'string' && identity.length > 0

	if (Array.isArray(existing)) {
		let matchIndex = -1
		if (hasIdentity) matchIndex = existing.findIndex((candidate) => candidate?.[identityField] === identity)
		if (matchIndex >= 0) existing[matchIndex] = { ...existing[matchIndex], ...entry }
		else existing.push(entry)
		s[provider] = existing
	} else if (existing) {
		if (hasIdentity && existing[identityField] === identity) {
			s[provider] = { ...existing, ...entry }
		} else {
			s[provider] = [existing, entry]
		}
	} else {
		s[provider] = entry
	}
	liveFiles.save(s)
}

export const authLogin = {
	state,
	startAnthropic,
	finishAnthropic,
	openaiRedirectUri,
	loginOpenai,
	awaitOpenaiCallback,
	handleOpenaiCallback,
	saveAuth,
}
