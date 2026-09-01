// Anthropic Claude subscription usage via api.anthropic.com/api/oauth/usage.

import { auth, type Credential } from './auth.ts'
import { STATE_DIR } from './state.ts'
import { liveFiles } from '../utils/live-file.ts'
import { subscriptionUsage } from '../common/subscription-usage.ts'
import { time } from '../utils/time.ts'

const CACHE_PATH = `${STATE_DIR}/anthropic-usage.ason`
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

export interface UsageWindow {
	usedPercent: number
	resetAt?: number
}

export interface AccountUsage {
	key: string
	email?: string
	index?: number
	total?: number
	fetchedAt?: string
	fiveHour?: UsageWindow
	sevenDay?: UsageWindow
	modelWeek?: UsageWindow & { label: string }
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
	anthropicUsage.state = liveFiles.liveFile(CACHE_PATH, defaultState()) as UsageState
	fix()
}

function fix(): void {
	if (typeof anthropicUsage.state.currentKey !== 'string') anthropicUsage.state.currentKey = ''
	if (typeof anthropicUsage.state.updatedAt !== 'string') anthropicUsage.state.updatedAt = ''
	if (!anthropicUsage.state.accounts || typeof anthropicUsage.state.accounts !== 'object') anthropicUsage.state.accounts = {}
	for (const [key, account] of Object.entries(anthropicUsage.state.accounts)) {
		if (!account || typeof account !== 'object') {
			delete anthropicUsage.state.accounts[key]
			continue
		}
		if (typeof account.key !== 'string') account.key = key
	}
}

function save(): void {
	anthropicUsage.init()
	fix()
	anthropicUsage.state.updatedAt = new Date().toISOString()
	liveFiles.save(anthropicUsage.state)
}

function onChange(cb: () => void): void {
	anthropicUsage.init()
	liveFiles.onChange(anthropicUsage.state, () => {
		fix()
		cb()
	})
}

function keyOf(credential: Pick<Credential, '_key' | 'index'>): string {
	return credential._key ?? `anthropic:${credential.index ?? 0}`
}

function credentials(): Credential[] {
	return auth.listCredentials('anthropic').filter((credential) => credential.type === 'token')
}

function hasCredentials(): boolean {
	return credentials().length > 0
}

function normalizePercent(raw: unknown): number | undefined {
	const value = Number(raw)
	if (!Number.isFinite(value)) return
	const scaled = value <= 1 ? value * 100 : value
	return Math.max(0, Math.min(100, scaled))
}

function parseIsoReset(raw: unknown): number | undefined {
	if (typeof raw !== 'string' || !raw.trim()) return
	const ts = Date.parse(raw)
	if (!Number.isFinite(ts)) return
	return ts
}

function parseWindow(raw: any): UsageWindow | undefined {
	const usedPercent = normalizePercent(raw?.utilization)
	if (usedPercent == null) return
	return {
		usedPercent,
		resetAt: parseIsoReset(raw?.resets_at),
	}
}

function parsePayload(credential: Credential, raw: any): AccountUsage {
	const sonnet = parseWindow(raw?.seven_day_sonnet)
	const opus = parseWindow(raw?.seven_day_opus)
	return {
		key: keyOf(credential),
		email: credential.email,
		index: credential.index,
		total: credential.total,
		fetchedAt: new Date().toISOString(),
		fiveHour: parseWindow(raw?.five_hour),
		sevenDay: parseWindow(raw?.seven_day),
		modelWeek: sonnet ? { ...sonnet, label: 'Sonnet' } : opus ? { ...opus, label: 'Opus' } : undefined,
	}
}

/** Fetch account email from the OAuth profile endpoint. */
async function fetchProfileEmail(credential: Credential): Promise<string | undefined> {
	try {
		const res = await fetch(PROFILE_URL, {
			headers: {
				Authorization: `Bearer ${credential.value}`,
				'Content-Type': 'application/json',
			},
			signal: AbortSignal.timeout(config.fetchTimeoutMs),
		})
		if (!res.ok) return
		const data = (await res.json()) as any
		return data?.account?.email || data?.account?.display_name || undefined
	} catch {
		return
	}
}

function current(): AccountUsage | null {
	anthropicUsage.init()
	fix()
	return anthropicUsage.state.currentKey ? anthropicUsage.state.accounts[anthropicUsage.state.currentKey] ?? null : null
}

function all(): AccountUsage[] {
	anthropicUsage.init()
	fix()
	return Object.values(anthropicUsage.state.accounts).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
}

function setCurrentCredential(credential: Credential | undefined): void {
	anthropicUsage.init()
	if (!credential || credential.type !== 'token') return
	const key = keyOf(credential)
	if (anthropicUsage.state.currentKey === key) return
	anthropicUsage.state.currentKey = key
	save()
}

function formatResetAt(resetAt: number, now = new Date()): string {
	return time.formatResetAt(resetAt, now)
}

function displayAccount(account: AccountUsage): string {
	const raw = account.email || (account.total && account.index != null ? `account ${account.index + 1}/${account.total}` : account.key)
	return subscriptionUsage.config.censorEmails && account.email ? subscriptionUsage.censorEmail(raw) : raw
}

function displaySlot(account: AccountUsage): string {
	const slot = account.index != null && account.total ? `${account.index + 1}/${account.total}` : '-'
	return anthropicUsage.state.currentKey === account.key ? `${slot} *` : slot
}

function usageBar(usedPercent: number): string {
	return subscriptionUsage.usageBarMarker(usedPercent, config.progressBarWidth)
}

function formatWindowText(window: UsageWindow | undefined): string {
	if (!window) return '?'
	return `${Math.round(window.usedPercent)}% used${window.resetAt ? ` (resets ${formatResetAt(window.resetAt)})` : ''}`
}

function formatWindowCell(window: UsageWindow | undefined): string {
	if (!window) return '?'
	return `${usageBar(window.usedPercent)}<br>${formatWindowText(window)}`
}

function formatStatusText(): string {
	const accounts = all()
	if (accounts.length === 0) return 'No cached Anthropic subscription usage. Run /status again after logging in with Claude.'

	// Check if any account has model-specific weekly data
	const hasModelWeek = accounts.some((a) => a.modelWeek)

	const header = hasModelWeek
		? '| Slot | Account | 5h | 7d | ' + accounts.find((a) => a.modelWeek)!.modelWeek!.label + ' 7d |'
		: '| Slot | Account | 5h | 7d |'
	const separator = hasModelWeek ? '|---|---|---|---|---|' : '|---|---|---|---|'

	const lines = [
		'Anthropic subscriptions:',
		'',
		header,
		separator,
	]
	for (const account of accounts) {
		let row = `| ${displaySlot(account)} | ${displayAccount(account)} | ${formatWindowCell(account.fiveHour)} | ${formatWindowCell(account.sevenDay)} |`
		if (hasModelWeek) {
			const mw = account.modelWeek
			row += ` ${mw ? formatWindowCell(mw) : '-'} |`
		}
		lines.push(row)
	}
	return lines.join('\n')
}

async function fetchUsage(credential: Credential): Promise<AccountUsage> {
	const res = await fetch(USAGE_URL, {
		headers: {
			Authorization: `Bearer ${credential.value}`,
			Accept: 'application/json',
			'anthropic-version': '2023-06-01',
			'anthropic-beta': 'oauth-2025-04-20',
			'User-Agent': 'hal',
		},
		signal: AbortSignal.timeout(config.fetchTimeoutMs),
	})
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		throw new Error(`/api/oauth/usage ${res.status}: ${text.slice(0, 200)}`)
	}
	return parsePayload(credential, await res.json())
}

async function refreshCredential(credential: Credential, force = false): Promise<AccountUsage> {
	const key = keyOf(credential)
	const existing = anthropicUsage.state.accounts[key]
	const lastFetch = existing?.fetchedAt ? Date.parse(existing.fetchedAt) : 0
	if (!force && existing && lastFetch && Date.now() - lastFetch < config.minAutoRefreshMs) return existing
	const account = await fetchUsage(credential)
	// If the credential doesn't have an email yet, try fetching from the profile endpoint
	if (!account.email) {
		account.email = existing?.email || await fetchProfileEmail(credential)
	}
	anthropicUsage.state.accounts[key] = account
	if (!anthropicUsage.state.currentKey) anthropicUsage.state.currentKey = key
	save()
	return anthropicUsage.state.accounts[key]!
}

async function refreshAll(force = false): Promise<AccountUsage[]> {
	anthropicUsage.init()
	await auth.ensureFresh('anthropic')
	const creds = credentials()
	// Prune cached accounts whose credentials no longer exist in auth.ason.
	// Done before refresh so that refreshCredential's "first credential becomes current"
	// fallback can kick in if the stale currentKey gets cleared.
	const activeKeys = new Set(creds.map(keyOf))
	let changed = false
	for (const key of Object.keys(anthropicUsage.state.accounts)) {
		if (!activeKeys.has(key)) {
			delete anthropicUsage.state.accounts[key]
			if (anthropicUsage.state.currentKey === key) anthropicUsage.state.currentKey = ''
			changed = true
		}
	}
	if (changed) save()
	for (const credential of creds) await refreshCredential(credential, force)
	return all()
}

async function renderStatus(force = true): Promise<string> {
	if (credentials().length === 0) return 'No Anthropic Claude subscriptions configured.'
	try {
		await refreshAll(force)
		return formatStatusText()
	} catch (err: any) {
		const suffix = err?.message ? String(err.message) : String(err)
		return all().length > 0 ? `${formatStatusText()}\n\nRefresh failed: ${suffix}` : `Anthropic subscription usage unavailable: ${suffix}`
	}
}

export const anthropicUsage = {
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
	renderStatus,
	parsePayload,
}
