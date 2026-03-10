// Auth — reads HAL_DIR/auth.ason (shared with old code), handles OAuth refresh.
// Uses liveFile so external edits (e.g. scripts/login-*.ts) are picked up.

import { liveFile } from '../utils/live-file.ts'
import { HAL_DIR } from '../state.ts'

const AUTH_PATH = `${HAL_DIR}/auth.ason`
const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'

let _auth: Record<string, any> | null = null

function authStore(): Record<string, any> {
	if (!_auth) _auth = liveFile(AUTH_PATH, { defaults: {} })
	return _auth
}

export function getAuth(provider: string): { accessToken: string; refreshToken?: string; expires?: number; accountId?: string } {
	return authStore()[provider] ?? {}
}

export async function refreshAnthropicAuth(): Promise<void> {
	const a = getAuth('anthropic')
	if (!a.refreshToken || Date.now() < (a.expires ?? 0)) return

	const res = await fetch('https://console.anthropic.com/v1/oauth/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: a.refreshToken, client_id: ANTHROPIC_CLIENT_ID }),
	})
	const data = (await res.json()) as any
	if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`)

	// Top-level property set triggers liveFile flush
	authStore().anthropic = { ...authStore().anthropic, accessToken: data.access_token, refreshToken: data.refresh_token, expires: Date.now() + data.expires_in * 1000 }
}

// ── OpenAI ──

function decodeJwtPayload(token: string): any | null {
	try {
		const parts = token.split('.')
		if (parts.length !== 3) return null
		return JSON.parse(atob(parts[1]))
	} catch {
		return null
	}
}

export function extractOpenAIAccountId(token: string): string | null {
	const payload = decodeJwtPayload(token)
	const id = payload?.['https://api.openai.com/auth']?.chatgpt_account_id
	return typeof id === 'string' && id.length > 0 ? id : null
}

export function isApiKey(token: string): boolean {
	return /^sk-[A-Za-z0-9]/.test(token)
}

function hasScope(token: string, scope: string): boolean {
	const payload = decodeJwtPayload(token)
	if (!payload) return false
	for (const claim of [payload.scp, payload.scope]) {
		if (Array.isArray(claim) && claim.includes(scope)) return true
		if (typeof claim === 'string' && claim.split(/\s+/).includes(scope)) return true
	}
	return false
}

export function openaiUsesCodex(token: string): boolean {
	if (isApiKey(token)) return false
	return !hasScope(token, 'api.responses.write')
}

export async function refreshOpenAIAuth(): Promise<void> {
	const a = getAuth('openai')
	if (!a.accessToken) return
	if (isApiKey(a.accessToken)) return
	if (!a.refreshToken) return
	if (Date.now() < (a.expires ?? 0) - 60_000) return

	const res = await fetch(OPENAI_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: a.refreshToken,
			client_id: OPENAI_CLIENT_ID,
		}),
	})
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		throw new Error(`OpenAI token refresh failed: ${res.status} ${text}`)
	}
	const data = (await res.json()) as any
	if (!data.access_token) throw new Error('OpenAI token refresh response missing access_token')

	const accountId = extractOpenAIAccountId(data.access_token)
	authStore().openai = {
		...authStore().openai,
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expires: Date.now() + (data.expires_in ?? 3600) * 1000,
		...(accountId ? { accountId } : {}),
	}
}

export const auth = {
	getAuth,
	refreshAnthropicAuth,
	extractOpenAIAccountId,
	isApiKey,
	openaiUsesCodex,
	refreshOpenAIAuth,
}