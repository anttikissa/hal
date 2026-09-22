// OpenCode Go subscription usage via opencode.ai/zen/go/v1/usage.
//
// TODO: this is the third near-identical usage module (see anthropic-usage.ts and
// openai-usage.ts). Extract the shared machinery — liveFile state, fix/init/save/
// onChange, keyOf, current/all, setCurrentCredential, the markdown table and
// refreshAll — into server/subscription-usage-store.ts before a fourth subscription
// lands. Each module would shrink by roughly 150 lines.
//
// Go is a subscription that authenticates with an API key, so unlike the other two
// the credential type carries no meaning here: every configured key is an account.

import { auth, type Credential } from './auth.ts'
import { STATE_DIR } from './state.ts'
import { liveFiles } from '../utils/live-file.ts'
import { subscriptionUsage } from '../common/subscription-usage.ts'
import { time } from '../utils/time.ts'
import { subscriptionLog, type SubscriptionWindow } from './subscription-log.ts'

const CACHE_PATH = `${STATE_DIR}/opencode-usage.ason`
const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

export interface UsageWindow {
	usedPercent: number
	resetAt?: number
}

export interface AccountUsage {
	key: string
	index?: number
	total?: number
	fetchedAt?: string
	rolling?: UsageWindow
	weekly?: UsageWindow
	monthly?: UsageWindow
}

const config = {
	minAutoRefreshMs: 60_000,
	fetchTimeoutMs: 5_000,
	progressBarWidth: 14,
}

interface UsageState {
	currentKey: string
	updatedAt: string
	accounts: Record<string, AccountUsage>
}

const runtime = {
	initialized: false,
}

function defaultState(): UsageState {
	return { currentKey: '', updatedAt: '', accounts: {} }
}

let state = defaultState()

function init(): void {
	if (runtime.initialized) return
	runtime.initialized = true
	opencodeUsage.state = liveFiles.liveFile(CACHE_PATH, defaultState()) as UsageState
	fix()
}

function fix(): void {
	if (typeof opencodeUsage.state.currentKey !== 'string') opencodeUsage.state.currentKey = ''
	if (typeof opencodeUsage.state.updatedAt !== 'string') opencodeUsage.state.updatedAt = ''
	if (!opencodeUsage.state.accounts || typeof opencodeUsage.state.accounts !== 'object') opencodeUsage.state.accounts = {}
	for (const [key, account] of Object.entries(opencodeUsage.state.accounts)) {
		if (!account || typeof account !== 'object') {
			delete opencodeUsage.state.accounts[key]
			continue
		}
		if (typeof account.key !== 'string') account.key = key
	}
}

function save(): void {
	opencodeUsage.init()
	fix()
	opencodeUsage.state.updatedAt = new Date().toISOString()
	liveFiles.save(opencodeUsage.state)
}

function onChange(cb: () => void): void {
	opencodeUsage.init()
	liveFiles.onChange(opencodeUsage.state, () => {
		fix()
		cb()
	})
}

function keyOf(credential: Pick<Credential, '_key' | 'index'>): string {
	return credential._key ?? `opencode-go:${credential.index ?? 0}`
}

function credentials(): Credential[] {
	return auth.listCredentials('opencode-go')
}

function hasCredentials(): boolean {
	return credentials().length > 0
}

/** The endpoint reports percent already scaled to 0-100, and ISO reset times. */
function parseWindow(raw: any): UsageWindow | undefined {
	const value = Number(raw?.percent)
	if (!Number.isFinite(value)) return
	const window: UsageWindow = { usedPercent: Math.max(0, Math.min(100, value)) }
	const resetAt = typeof raw?.resetsAt === 'string' ? Date.parse(raw.resetsAt) : NaN
	if (Number.isFinite(resetAt)) window.resetAt = resetAt
	return window
}

function parsePayload(credential: Credential, raw: any): AccountUsage {
	return {
		key: keyOf(credential),
		index: credential.index,
		total: credential.total,
		fetchedAt: new Date().toISOString(),
		rolling: parseWindow(raw?.usage?.rolling),
		weekly: parseWindow(raw?.usage?.weekly),
		monthly: parseWindow(raw?.usage?.monthly),
	}
}

function observationWindows(account: AccountUsage): SubscriptionWindow[] {
	const values = [
		{ label: '5h', durationMinutes: 300, window: account.rolling },
		{ label: '7d', durationMinutes: 10_080, window: account.weekly },
		{ label: '30d', durationMinutes: 43_200, window: account.monthly },
	]
	const windows: SubscriptionWindow[] = []
	for (const value of values) {
		if (!value.window) continue
		const window: SubscriptionWindow = {
			label: value.label,
			durationMinutes: value.durationMinutes,
			usedPercent: value.window.usedPercent,
		}
		if (value.window.resetAt != null) window.resetAt = value.window.resetAt
		windows.push(window)
	}
	return windows
}

function current(): AccountUsage | null {
	opencodeUsage.init()
	fix()
	return opencodeUsage.state.currentKey ? opencodeUsage.state.accounts[opencodeUsage.state.currentKey] ?? null : null
}

function all(): AccountUsage[] {
	opencodeUsage.init()
	fix()
	return Object.values(opencodeUsage.state.accounts).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
}

function setCurrentCredential(credential: Credential | undefined): void {
	opencodeUsage.init()
	if (!credential) return
	const key = keyOf(credential)
	if (opencodeUsage.state.currentKey === key) return
	opencodeUsage.state.currentKey = key
	save()
}

function formatResetAt(resetAt: number, now = new Date()): string {
	return time.formatResetAt(resetAt, now)
}

function displaySlot(account: AccountUsage): string {
	const slot = account.index != null && account.total ? `${account.index + 1}/${account.total}` : '-'
	return opencodeUsage.state.currentKey === account.key ? `${slot} *` : slot
}

function formatWindowCell(window: UsageWindow | undefined): string {
	if (!window) return '?'
	const bar = subscriptionUsage.usageBarMarker(window.usedPercent, config.progressBarWidth)
	const resets = window.resetAt ? ` (resets ${formatResetAt(window.resetAt)})` : ''
	return `${bar}<br>${Math.round(window.usedPercent)}% used${resets}`
}

function formatStatusText(): string {
	const accounts = all()
	if (accounts.length === 0) return 'No cached OpenCode Go subscription usage. Run /status again after configuring a key.'

	const lines = [
		'OpenCode Go subscriptions:',
		'',
		'| Slot | Account | 5h | 7d | 30d |',
		'|---|---|---|---|---|',
	]
	for (const account of accounts) {
		lines.push(`| ${displaySlot(account)} | ${account.key} | ${formatWindowCell(account.rolling)} | ${formatWindowCell(account.weekly)} | ${formatWindowCell(account.monthly)} |`)
	}
	return lines.join('\n')
}

async function fetchUsage(credential: Credential): Promise<AccountUsage> {
	const res = await fetch(USAGE_URL, {
		headers: {
			Authorization: `Bearer ${credential.value}`,
			Accept: 'application/json',
			'User-Agent': 'hal',
		},
		signal: AbortSignal.timeout(config.fetchTimeoutMs),
	})
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		// 403 means the key is valid but has no Go subscription, which is worth
		// saying plainly rather than showing as a generic HTTP failure.
		if (res.status === 403) throw new Error('No OpenCode Go subscription for this key')
		throw new Error(`/zen/go/v1/usage ${res.status}: ${text.slice(0, 200)}`)
	}
	return parsePayload(credential, await res.json())
}

async function refreshCredential(credential: Credential, force = false): Promise<AccountUsage> {
	const key = keyOf(credential)
	const existing = opencodeUsage.state.accounts[key]
	const lastFetch = existing?.fetchedAt ? Date.parse(existing.fetchedAt) : 0
	if (!force && existing && lastFetch && Date.now() - lastFetch < config.minAutoRefreshMs) return existing
	const account = await fetchUsage(credential)
	subscriptionLog.observe(
		'opencode-go',
		key,
		opencodeUsage.observationWindows(account),
		existing ? opencodeUsage.observationWindows(existing) : undefined,
	)
	opencodeUsage.state.accounts[key] = account
	if (!opencodeUsage.state.currentKey) opencodeUsage.state.currentKey = key
	save()
	return opencodeUsage.state.accounts[key]!
}

async function refreshAll(force = false): Promise<AccountUsage[]> {
	opencodeUsage.init()
	const creds = credentials()
	// Prune cached accounts whose credentials no longer exist, before refreshing, so
	// the "first credential becomes current" fallback below can take over.
	const activeKeys = new Set(creds.map(keyOf))
	let changed = false
	for (const key of Object.keys(opencodeUsage.state.accounts)) {
		if (!activeKeys.has(key)) {
			delete opencodeUsage.state.accounts[key]
			if (opencodeUsage.state.currentKey === key) opencodeUsage.state.currentKey = ''
			changed = true
		}
	}
	if (changed) save()
	for (const credential of creds) await refreshCredential(credential, force)
	return all()
}

async function renderStatus(force = true): Promise<string> {
	if (credentials().length === 0) return 'No OpenCode Go subscriptions configured.'
	try {
		await refreshAll(force)
		return formatStatusText()
	} catch (err: any) {
		const suffix = err?.message ? String(err.message) : String(err)
		return all().length > 0 ? `${formatStatusText()}\n\nRefresh failed: OpenCode Go: ${suffix}` : `OpenCode Go usage unavailable: ${suffix}`
	}
}

export const opencodeUsage = {
	config,
	runtime,
	init,
	state,
	onChange,
	save,
	hasCredentials,
	all,
	current,
	setCurrentCredential,
	refreshAll,
	formatResetAt,
	formatStatusText,
	observationWindows,
	parsePayload,
	renderStatus,
}
