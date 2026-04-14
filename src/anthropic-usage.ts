// Anthropic Claude subscription usage via api.anthropic.com/api/oauth/usage.

import { auth, type Credential } from './auth.ts'
import { STATE_DIR } from './state.ts'
import { liveFiles } from './utils/live-file.ts'

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
	pendingTokens: number
}

const config = {
	minAutoRefreshMs: 60_000,
	fetchTimeoutMs: 5_000,
	censorEmails: false,
	progressBarWidth: 14,
}

const state = liveFiles.liveFile(CACHE_PATH, {
	currentKey: '',
	updatedAt: '',
	accounts: {} as Record<string, AccountUsage>,
})

function fix(): void {
	if (typeof state.currentKey !== 'string') state.currentKey = ''
	if (typeof state.updatedAt !== 'string') state.updatedAt = ''
	if (!state.accounts || typeof state.accounts !== 'object') state.accounts = {}
	for (const [key, account] of Object.entries(state.accounts)) {
		if (!account || typeof account !== 'object') {
			delete state.accounts[key]
			continue
		}
		if (typeof account.key !== 'string') account.key = key
		if (typeof account.pendingTokens !== 'number') account.pendingTokens = 0
	}
}

fix()

function save(): void {
	fix()
	state.updatedAt = new Date().toISOString()
	liveFiles.save(state)
}

function onChange(cb: () => void): void {
	liveFiles.onChange(state, () => {
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
		pendingTokens: 0,
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
	fix()
	return state.currentKey ? state.accounts[state.currentKey] ?? null : null
}

function all(): AccountUsage[] {
	fix()
	return Object.values(state.accounts).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
}

function setCurrentCredential(credential: Credential | undefined): void {
	if (!credential || credential.type !== 'token') return
	const key = keyOf(credential)
	if (state.currentKey === key) return
	state.currentKey = key
	save()
}

function formatResetAt(resetAt: number, now = new Date()): string {
	const d = new Date(resetAt)
	const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
	const sameDay =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate()
	if (sameDay) return time
	return `${time} on ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}`
}

function maskLabel(label: string, stars: number): string {
	if (!label) return ''
	return `${label[0]}${'*'.repeat(stars)}`
}

function censorEmail(email: string): string {
	const at = email.indexOf('@')
	if (at === -1) return email
	const local = email.slice(0, at)
	const domain = email.slice(at + 1)
	const dot = domain.indexOf('.')
	if (dot === -1) return email
	const domainLabel = domain.slice(0, dot)
	const suffix = domain.slice(dot + 1)
	const maskedDomain = maskLabel(domainLabel, domainLabel.length <= 5 ? 4 : 3)
	return `${maskLabel(local, 3)}@${maskedDomain}.${suffix}`
}

function displayAccount(account: AccountUsage): string {
	const raw = account.email || (account.total && account.index != null ? `account ${account.index + 1}/${account.total}` : account.key)
	return config.censorEmails && account.email ? censorEmail(raw) : raw
}

function displaySlot(account: AccountUsage): string {
	const slot = account.index != null && account.total ? `${account.index + 1}/${account.total}` : '-'
	return state.currentKey === account.key ? `${slot} *` : slot
}

function usageBar(usedPercent: number): string {
	const width = Math.max(1, Math.round(config.progressBarWidth))
	const clamped = Math.max(0, Math.min(100, usedPercent))
	const halfSteps = Math.round((clamped / 100) * width * 2)
	const full = Math.floor(halfSteps / 2)
	const half = halfSteps % 2
	const empty = width - full - half
	return `[${'█'.repeat(full)}${half ? '▌' : ''}${'░'.repeat(empty)}]`
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
		? '| Slot | Account | 5h | Week | ' + accounts.find((a) => a.modelWeek)!.modelWeek!.label + ' week |'
		: '| Slot | Account | 5h | Week |'
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
	const existing = state.accounts[key]
	const lastFetch = existing?.fetchedAt ? Date.parse(existing.fetchedAt) : 0
	if (!force && existing && lastFetch && Date.now() - lastFetch < config.minAutoRefreshMs) return existing
	const account = await fetchUsage(credential)
	// If the credential doesn't have an email yet, try fetching from the profile endpoint
	if (!account.email) {
		account.email = existing?.email || await fetchProfileEmail(credential)
	}
	state.accounts[key] = account
	if (!state.currentKey) state.currentKey = key
	save()
	return state.accounts[key]!
}

async function refreshAll(force = false): Promise<AccountUsage[]> {
	await auth.ensureFresh('anthropic')
	for (const credential of credentials()) await refreshCredential(credential, force)
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
	state,
	onChange,
	save,
	all,
	current,
	setCurrentCredential,
	refreshAll,
	formatResetAt,
	formatStatusText,
	renderStatus,
	parsePayload,
}
