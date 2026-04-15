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
	/** Zero-based position inside the provider's account pool. */
	index?: number
	/** Total number of configured accounts for this provider. */
	total?: number
	/** Internal key for cooldown tracking. Absent for env-var credentials. */
	_key?: string
}

// ── Cooldown tracking ──
// Map of "provider:index" -> timestamp when cooldown expires.
// Persisted to STATE_DIR/cooldowns.json so cooldowns survive restarts.
// Loaded lazily on first access, written on every markCooldown call.

import { STATE_DIR } from './state.ts'
import { readFileSync, writeFileSync } from 'fs'

const COOLDOWN_PATH = `${STATE_DIR}/cooldowns.json`
let cooldowns: Map<string, number> | null = null  // null = not yet loaded

function loadCooldowns(): Map<string, number> {
	if (cooldowns) return cooldowns
	cooldowns = new Map()
	try {
		const data = JSON.parse(readFileSync(COOLDOWN_PATH, 'utf8'))
		const now = Date.now()
		// Only load entries that haven't expired yet
		for (const [key, until] of Object.entries(data)) {
			if (typeof until === 'number' && until > now) {
				cooldowns.set(key, until)
			}
		}
	} catch {
		// File doesn't exist or is corrupt — start fresh
	}
	return cooldowns
}

function saveCooldowns(): void {
	const map = loadCooldowns()
	const obj: Record<string, number> = {}
	const now = Date.now()
	for (const [key, until] of map) {
		// Only persist entries that haven't expired
		if (until > now) obj[key] = until
	}
	try {
		writeFileSync(COOLDOWN_PATH, JSON.stringify(obj), 'utf8')
	} catch {
		// State dir may not exist yet during early startup
	}
}

/** Normalize a provider entry: single object → [object], array stays array. */
function normalizeEntries(raw: any): any[] {
	if (!raw) return []
	if (Array.isArray(raw)) return raw
	return [raw]
}

/**
 * Cooldowns must follow the real account, not its current array slot.
 * OpenAI stores accountId/email, Anthropic may only have slot order for now.
 */
function cooldownKey(providerName: string, entry: any, index: number): string {
	const id =
		typeof entry?.accountId === 'string' && entry.accountId ? entry.accountId
			: typeof entry?.email === 'string' && entry.email ? entry.email
			: typeof entry?.id === 'string' && entry.id ? entry.id
			: ''
	return `${providerName}:${id || index}`
}

/** Extract credential from a single auth entry. */
function credFromEntry(entry: any, key: string, index: number, total: number): Credential | undefined {
	if (entry.accessToken) return { value: entry.accessToken, type: 'token', email: entry.email, index, total, _key: key }
	if (entry.apiKey) return { value: entry.apiKey, type: 'api-key', email: entry.email, index, total, _key: key }
	return undefined
}

/** Get all configured credentials for a provider, in configured order. */
function listCredentials(providerName: string): Credential[] {
	const raw = store()[providerName]
	const entries = normalizeEntries(raw)
	const total = entries.length
	const credentials: Credential[] = []
	for (let i = 0; i < entries.length; i++) {
		const key = cooldownKey(providerName, entries[i], i)
		const cred = credFromEntry(entries[i], key, i, total)
		if (cred) credentials.push(cred)
	}
	return credentials
}

/** Get credential for a provider. Skips accounts on cooldown. */
function getCredential(providerName: string): Credential | undefined {
	const raw = store()[providerName]
	const entries = normalizeEntries(raw)
	const now = Date.now()
	const total = entries.length

	// Try each entry, skip ones on cooldown
	for (let i = 0; i < entries.length; i++) {
		const key = cooldownKey(providerName, entries[i], i)
		const cooldownUntil = loadCooldowns().get(key)
		if (cooldownUntil && now < cooldownUntil) continue
		const cred = credFromEntry(entries[i], key, i, total)
		if (cred) return cred
	}

	// Fall back to env var
	const envVar = ENV_KEYS[providerName] ?? `${providerName.toUpperCase()}_API_KEY`
	const envVal = process.env[envVar]
	if (envVal) return { value: envVal, type: 'api-key' }

	// All on cooldown — return the one that comes off soonest
	let bestIdx = -1, bestUntil = Infinity
	for (let i = 0; i < entries.length; i++) {
		const until = loadCooldowns().get(cooldownKey(providerName, entries[i], i)) ?? 0
		if (until < bestUntil) { bestUntil = until; bestIdx = i }
	}
	if (bestIdx >= 0) return credFromEntry(entries[bestIdx], cooldownKey(providerName, entries[bestIdx], bestIdx), bestIdx, total)
	return undefined
}

/** Mark a credential as on cooldown for durationMs. Persists to disk. */
function markCooldown(cred: Credential, durationMs: number): void {
	if (!cred._key) return
	loadCooldowns().set(cred._key, Date.now() + durationMs)
	saveCooldowns()
}

/** Clear one account's cooldown immediately. */
function clearCooldown(cred: Credential): void {
	if (!cred._key) return
	loadCooldowns().delete(cred._key)
	saveCooldowns()
}

/** True if at least one credential for this provider is NOT on cooldown. */
function hasAvailableCredential(providerName: string): boolean {
	const entries = normalizeEntries(store()[providerName])
	const now = Date.now()
	for (let i = 0; i < entries.length; i++) {
		const until = loadCooldowns().get(cooldownKey(providerName, entries[i], i)) ?? 0
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
		const cooldownUntil = loadCooldowns().get(cooldownKey(providerName, entries[i], i))
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
			const cooldownUntil = loadCooldowns().get(cooldownKey(providerName, raw[i], i))
			if (cooldownUntil && now < cooldownUntil) continue
			return raw[i] ?? {}
		}
		// All on cooldown — return first
		return raw[0] ?? {}
	}
	return raw ?? {}
}

// ── Token refresh ──

/** Refresh Anthropic OAuth tokens if expired. Handles both single and multi-account. */
async function refreshAnthropic(): Promise<void> {
	const raw = store().anthropic
	const entries = normalizeEntries(raw)

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]
		if (!entry?.refreshToken) continue
		if (entry.expires && Date.now() < entry.expires - 60_000) continue

		const res = await fetch('https://console.anthropic.com/v1/oauth/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				grant_type: 'refresh_token',
				refresh_token: entry.refreshToken,
				client_id: ANTHROPIC_CLIENT_ID,
			}),
		})
		if (!res.ok) {
			const text = await res.text().catch(() => '')
			throw new Error(`Anthropic token refresh failed: ${res.status} ${text}`)
		}
		const data = (await res.json()) as any
		if (!data.access_token) throw new Error('Anthropic refresh: missing access_token')

		const updated = {
			...entry,
			accessToken: data.access_token,
			refreshToken: data.refresh_token,
			expires: Date.now() + (data.expires_in ?? 3600) * 1000,
		}

		if (Array.isArray(raw)) {
			raw[i] = updated
			store().anthropic = raw
		} else {
			store().anthropic = updated
		}
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
	cooldowns = new Map()
}

/** Force next loadCooldowns() to re-read from disk. For testing restart. */
function _invalidateCooldownCache(): void {
	cooldowns = null
}

export const auth = {
	getCredential,
	listCredentials,
	getEntry,
	ensureFresh,
	isApiKey,
	markCooldown,
	clearCooldown,
	hasAvailableCredential,
	allOnCooldownMessage,
	_setStoreForTest,
	_resetCooldowns,
	_invalidateCooldownCache,
}
export type { Credential }
