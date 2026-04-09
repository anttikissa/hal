// Auth — reads credentials from auth.ason, falls back to env vars.
// auth.ason is live-reloaded so OAuth login scripts take effect immediately.
//
// Credential priority:
// 1. auth.ason accessToken (from OAuth login scripts)
// 2. auth.ason apiKey (from scripts/add-keys.ts)
// 3. Environment variable (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
//
// Token rotation:
// A provider entry can be a single object or an array of objects.
// Single: { accessToken, refreshToken, email, ... }
// Multiple: [{ accessToken, ..., email: "a@x.com" }, { ... }]
// When multiple accounts exist, getCredential() skips ones on cooldown.
// Call markCooldown() after a 429 to rotate to the next account.

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
	/** Identifying label (e.g. email) for the account this came from. */
	email?: string
	/** Internal key for cooldown tracking. Absent for env-var credentials. */
	_key?: string
}

// ── Cooldown tracking ──
// In-memory map of "provider:index" -> timestamp when cooldown expires.
// Populated by markCooldown(), checked by getCredential().

const cooldowns = new Map<string, number>()

/** Normalize a provider entry: single object → [object], array stays array. */
function normalizeEntries(raw: any): any[] {
	if (!raw) return []
	if (Array.isArray(raw)) return raw
	return [raw]
}

/** Extract credential from a single auth entry. */
function credFromEntry(entry: any, key: string): Credential | undefined {
	if (entry.accessToken) return { value: entry.accessToken, type: 'token', email: entry.email, _key: key }
	if (entry.apiKey) return { value: entry.apiKey, type: 'api-key', email: entry.email, _key: key }
	return undefined
}

/** Get credential for a provider. Skips accounts on cooldown. */
function getCredential(providerName: string): Credential | undefined {
	const raw = store()[providerName]
	const entries = normalizeEntries(raw)
	const now = Date.now()

	// Try each entry, skip ones on cooldown
	for (let i = 0; i < entries.length; i++) {
		const key = `${providerName}:${i}`
		const cooldownUntil = cooldowns.get(key)
		if (cooldownUntil && now < cooldownUntil) continue
		const cred = credFromEntry(entries[i], key)
		if (cred) return cred
	}

	// Fall back to env var
	const envVar = ENV_KEYS[providerName] ?? `${providerName.toUpperCase()}_API_KEY`
	const envVal = process.env[envVar]
	if (envVal) return { value: envVal, type: 'api-key' }

	// All on cooldown — return the one that comes off soonest
	let bestIdx = -1, bestUntil = Infinity
	for (let i = 0; i < entries.length; i++) {
		const until = cooldowns.get(`${providerName}:${i}`) ?? 0
		if (until < bestUntil) { bestUntil = until; bestIdx = i }
	}
	if (bestIdx >= 0) return credFromEntry(entries[bestIdx], `${providerName}:${bestIdx}`)
	return undefined
}

/** Mark a credential as on cooldown for durationMs. */
function markCooldown(cred: Credential, durationMs: number): void {
	if (!cred._key) return
	cooldowns.set(cred._key, Date.now() + durationMs)
}

/** True if at least one credential for this provider is NOT on cooldown. */
function hasAvailableCredential(providerName: string): boolean {
	const entries = normalizeEntries(store()[providerName])
	const now = Date.now()
	for (let i = 0; i < entries.length; i++) {
		const until = cooldowns.get(`${providerName}:${i}`) ?? 0
		if (now >= until) return true
	}
	return false
}

/** If all accounts for a provider are on cooldown, return a user-facing error message. */
function allOnCooldownMessage(providerName: string): string | null {
	const raw = store()[providerName]
	const entries = normalizeEntries(raw)
	if (entries.length === 0) return null

	const now = Date.now()
	// Check if any entry is NOT on cooldown
	for (let i = 0; i < entries.length; i++) {
		const key = `${providerName}:${i}`
		const cooldownUntil = cooldowns.get(key)
		if (!cooldownUntil || now >= cooldownUntil) return null
	}

	// All on cooldown — build message with account emails
	const emails = entries
		.map((e: any) => e.email)
		.filter(Boolean)
	const accountList = emails.length > 0
		? ` (${emails.join(', ')})`
		: ` (${entries.length} account${entries.length > 1 ? 's' : ''})`
	return `All ${providerName} accounts rate limited${accountList}. Add another account, upgrade your plan, or switch providers.`
}

/** Get full auth entry for a provider (for refresh, account ID, etc.) */
function getEntry(providerName: string): Record<string, any> {
	// For multi-account, return the entry matching the current (non-cooldown) credential
	const raw = store()[providerName]
	if (Array.isArray(raw)) {
		const now = Date.now()
		for (let i = 0; i < raw.length; i++) {
			const key = `${providerName}:${i}`
			const cooldownUntil = cooldowns.get(key)
			if (cooldownUntil && now < cooldownUntil) continue
			return raw[i] ?? {}
		}
		// All on cooldown — return first
		return raw[0] ?? {}
	}
	return raw ?? {}
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

/** Refresh OpenAI OAuth tokens if expired. Handles both single and multi-account. */
async function refreshOpenAI(): Promise<void> {
	const raw = store().openai
	const entries = normalizeEntries(raw)

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]
		if (!entry?.refreshToken) continue
		if (entry.accessToken && entry.accessToken.startsWith('sk-')) continue
		if (entry.expires && Date.now() < entry.expires - 60_000) continue

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

		const updated = {
			...entry,
			accessToken: data.access_token,
			refreshToken: data.refresh_token,
			expires: Date.now() + (data.expires_in ?? 3600) * 1000,
		}

		// Write back to the correct slot
		if (Array.isArray(raw)) {
			raw[i] = updated
			store().openai = raw
		} else {
			store().openai = updated
		}
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

// ── Test helpers ──

function _setStoreForTest(data: Record<string, any>): void {
	_store = data
}

function _resetCooldowns(): void {
	cooldowns.clear()
}

export const auth = {
	getCredential,
	getEntry,
	ensureFresh,
	isApiKey,
	markCooldown,
	hasAvailableCredential,
	allOnCooldownMessage,
	_setStoreForTest,
	_resetCooldowns,
}
export type { Credential }
