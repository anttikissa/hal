// Auth — reads credentials from auth.ason, falls back to env vars.
// auth.ason is live-reloaded so OAuth login scripts take effect immediately.
//
// Credential priority:
// 1. auth.ason accessToken (from OAuth login scripts)
// 2. auth.ason apiKey (from scripts/add-keys.ts)
// 3. Environment variable (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)

import { liveFiles } from './utils/live-file.ts'
import { HAL_DIR } from './state.ts'

const AUTH_PATH = `${HAL_DIR}/auth.ason`

// Anthropic OAuth client ID (shared with scripts/login-anthropic.ts)
const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

// OpenAI OAuth client ID (shared with scripts/login-openai.ts)
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'

// Live-reloaded auth store — external edits (login scripts) are picked up automatically
let _store: Record<string, any> | null = null
function store(): Record<string, any> {
	if (!_store) _store = liveFiles.liveFile(AUTH_PATH, {})
	return _store
}

// Map provider names to env var names
const ENV_KEYS: Record<string, string> = {
	anthropic: 'ANTHROPIC_API_KEY',
	openai: 'OPENAI_API_KEY',
	openrouter: 'OPENROUTER_API_KEY',
	google: 'GOOGLE_API_KEY',
	grok: 'GROK_API_KEY',
	serper: 'SERPER_API_KEY',
}

/** Credential with its type so callers know how to authenticate. */
interface Credential {
	value: string
	type: 'token' | 'api-key'
}

/** Get credential for a provider. Returns type so caller uses the right auth header. */
function getCredential(providerName: string): Credential | undefined {
	const entry = store()[providerName]
	if (entry) {
		if (entry.accessToken) return { value: entry.accessToken, type: 'token' }
		if (entry.apiKey) return { value: entry.apiKey, type: 'api-key' }
	}
	// Env vars are always API keys
	const envVar = ENV_KEYS[providerName] ?? `${providerName.toUpperCase()}_API_KEY`
	const envVal = process.env[envVar]
	if (envVal) return { value: envVal, type: 'api-key' }
	return undefined
}

/** Get full auth entry for a provider (for refresh, account ID, etc.) */
function getEntry(providerName: string): Record<string, any> {
	return store()[providerName] ?? {}
}

// ── Token refresh ──

/** Refresh Anthropic OAuth token if expired. No-op for API keys. */
async function refreshAnthropic(): Promise<void> {
	const entry = store().anthropic
	if (!entry?.refreshToken) return
	// Still valid? Skip. (60s buffer)
	if (entry.expires && Date.now() < entry.expires - 60_000) return

	const res = await fetch('https://console.anthropic.com/v1/oauth/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			grant_type: 'refresh_token',
			refresh_token: entry.refreshToken,
			client_id: ANTHROPIC_CLIENT_ID,
		}),
	})
	const data = (await res.json()) as any
	if (!data.access_token) throw new Error(`Anthropic token refresh failed: ${JSON.stringify(data)}`)

	// Write back — liveFile proxy auto-persists on property set
	store().anthropic = {
		...entry,
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expires: Date.now() + data.expires_in * 1000,
	}
}

/** Refresh OpenAI OAuth token if expired. No-op for API keys. */
async function refreshOpenAI(): Promise<void> {
	const entry = store().openai
	if (!entry?.refreshToken) return
	if (entry.accessToken && isApiKey(entry.accessToken)) return
	if (entry.expires && Date.now() < entry.expires - 60_000) return

	const res = await fetch(OPENAI_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: entry.refreshToken,
			client_id: OPENAI_CLIENT_ID,
		}),
	})
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		throw new Error(`OpenAI token refresh failed: ${res.status} ${text}`)
	}
	const data = (await res.json()) as any
	if (!data.access_token) throw new Error('OpenAI refresh: missing access_token')

	store().openai = {
		...entry,
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expires: Date.now() + (data.expires_in ?? 3600) * 1000,
	}
}

/** Refresh token for a provider if needed. Safe to call often. */
async function ensureFresh(providerName: string): Promise<void> {
	try {
		if (providerName === 'anthropic') await refreshAnthropic()
		else if (providerName === 'openai') await refreshOpenAI()
	} catch (e: any) {
		// Log but don't crash — stale token may still work, or user can re-login
		console.error(`Auth refresh (${providerName}):`, e.message)
	}
}

// Check whether a provider is using an API key (pay-per-token) or
// OAuth token (subscription). Returns true for API key, false for token/unknown.
function isApiKey(providerName: string): boolean {
	const cred = getCredential(providerName)
	return cred?.type === 'api-key'
}

export const auth = { getCredential, getEntry, ensureFresh, isApiKey }
export type { Credential }
