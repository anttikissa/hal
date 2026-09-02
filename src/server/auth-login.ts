// OAuth login flows for Anthropic (Claude) and OpenAI (ChatGPT).
//
// Anthropic: PKCE → user opens URL → pastes the returned code#state. The
// verifier is the returned state, so finishing survives a process restart.
// OpenAI: device authorization is the supported login flow for remote and headless hosts.

import { auth } from './auth.ts'
import { liveFiles } from '../utils/live-file.ts'

const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const ANTHROPIC_REDIRECT = 'https://console.anthropic.com/oauth/code/callback'
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const ANTHROPIC_AUTHORIZE = 'https://claude.ai/oauth/authorize'
const ANTHROPIC_PROFILE = 'https://api.anthropic.com/api/oauth/profile'
const ANTHROPIC_SCOPE = 'org:create_api_key user:profile user:inference'

const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const OPENAI_DEVICE_AUTH_URL = 'https://auth.openai.com/api/accounts/deviceauth'
const OPENAI_DEVICE_CALLBACK = 'https://auth.openai.com/deviceauth/callback'


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

type OpenaiDeviceCode = {
	deviceAuthId: string
	userCode: string
	intervalMs: number
	verificationUrl: string
}

type OpenaiAuthorizationCode = {
	code: string
	verifier: string
}

async function requestOpenaiDeviceCode(): Promise<OpenaiDeviceCode> {
	const response = await fetch(`${OPENAI_DEVICE_AUTH_URL}/usercode`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
	})
	if (!response.ok) {
		if (response.status === 404) throw new Error('ChatGPT device-code login is unavailable. Enable device-code login in your ChatGPT security or workspace settings.')
		throw new Error(`ChatGPT device-code request failed: ${response.status}`)
	}
	const data = await response.json() as any
	if (typeof data.device_auth_id !== 'string' || typeof data.user_code !== 'string') throw new Error('ChatGPT device-code response missing required fields')
	const interval = Number(data.interval)
	return {
		deviceAuthId: data.device_auth_id,
		userCode: data.user_code,
		intervalMs: Math.max(0, Number.isFinite(interval) ? interval * 1_000 : 5_000),
		verificationUrl: 'https://auth.openai.com/codex/device',
	}
}

async function pollOpenaiDeviceCode(deviceCode: OpenaiDeviceCode): Promise<OpenaiAuthorizationCode> {
	const deadline = Date.now() + 15 * 60_000
	for (;;) {
		const response = await fetch(`${OPENAI_DEVICE_AUTH_URL}/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ device_auth_id: deviceCode.deviceAuthId, user_code: deviceCode.userCode }),
		})
		if (response.ok) {
			const data = await response.json() as any
			if (typeof data.authorization_code !== 'string' || typeof data.code_challenge !== 'string' || typeof data.code_verifier !== 'string') throw new Error('ChatGPT device-code response missing required fields')
			return { code: data.authorization_code, verifier: data.code_verifier }
		}
		if (response.status !== 403 && response.status !== 404) throw new Error(`ChatGPT device-code login failed: ${response.status}`)
		if (Date.now() >= deadline) throw new Error('ChatGPT device-code login timed out after 15 minutes')
		await Bun.sleep(deviceCode.intervalMs)
	}
}

async function loginOpenai(onProgress?: (msg: string) => void): Promise<{ accountId?: string }> {
	const deviceCode = await requestOpenaiDeviceCode()
	onProgress?.(`Open this URL to log in to ChatGPT:\n${deviceCode.verificationUrl}\n\nEnter this one-time code (expires in 15 minutes):\n${deviceCode.userCode}\n\nOnly continue if you started this login in Hal.`)
	authLogin.tryOpenBrowser(deviceCode.verificationUrl)
	const authorization = await pollOpenaiDeviceCode(deviceCode)

	const tokenRes = await fetch(OPENAI_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: OPENAI_CLIENT_ID,
			code: authorization.code,
			code_verifier: authorization.verifier,
			redirect_uri: OPENAI_DEVICE_CALLBACK,
		}),
	})
	if (!tokenRes.ok) {
		throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text().catch(() => '')}`)
	}
	const { access_token, refresh_token, expires_in } = await tokenRes.json() as any
	if (!access_token || !refresh_token) throw new Error('Token response missing required fields')

	const claims = decodeJwt(access_token)
	const accountId = claims?.['https://api.openai.com/auth']?.chatgpt_account_id ?? null
	// Store the email too: /status and the "all accounts rate limited" message name
	// accounts by email, and an accountId UUID tells the user nothing about which
	// login to go fix.
	const email = claims?.['https://api.openai.com/profile']?.email ?? null

	saveAuth('openai', {
		accessToken: access_token,
		refreshToken: refresh_token,
		expires: Date.now() + (expires_in ?? 3600) * 1000,
		...(accountId ? { accountId } : {}),
		...(email ? { email } : {}),
	})
	return { accountId }
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
	startAnthropic,
	finishAnthropic,
	requestOpenaiDeviceCode,
	pollOpenaiDeviceCode,
	loginOpenai,
	tryOpenBrowser,
	saveAuth,
}
