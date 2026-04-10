// OpenAI ChatGPT subscription usage via chatgpt.com/backend-api/wham/usage.

import { auth, type Credential } from './auth.ts'
import { STATE_DIR } from './state.ts'
import { liveFiles } from './utils/live-file.ts'
import { ipc } from './ipc.ts'

const CACHE_PATH = `${STATE_DIR}/openai-usage.ason`
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const DIM = '\x1b[90m'
const RESET = '\x1b[0m'

export interface UsageWindow {
	usedPercent: number
	windowMinutes: number
	resetAt: number
}

export interface AccountUsage {
	key: string
	email?: string
	index?: number
	total?: number
	planType?: string
	fetchedAt?: string
	primary?: UsageWindow
	secondary?: UsageWindow
	pendingTokens: number
}

interface UsageFile {
	currentKey: string
	lastActiveAt: string
	updatedAt: string
	accounts: Record<string, AccountUsage>
}

const config = {
	// Automatic refreshes should be quiet. /status bypasses this floor.
	minAutoRefreshMs: 60_000,
	activeWindowMs: 5 * 60_000,
	activeRefreshMs: 10 * 60_000,
	tokenRefreshThreshold: 100_000,
	activityWriteThrottleMs: 60_000,
	fetchTimeoutMs: 10_000,
}

function defaultFile(): UsageFile {
	return {
		currentKey: '',
		lastActiveAt: '',
		updatedAt: '',
		accounts: {},
	}
}

const state = liveFiles.liveFile(CACHE_PATH, defaultFile()) as UsageFile

function ensureShape(): void {
	if (typeof state.currentKey !== 'string') state.currentKey = ''
	if (typeof state.lastActiveAt !== 'string') state.lastActiveAt = ''
	if (typeof state.updatedAt !== 'string') state.updatedAt = ''
	if (!state.accounts || typeof state.accounts !== 'object') state.accounts = {}
	for (const [key, value] of Object.entries(state.accounts)) {
		if (!value || typeof value !== 'object') {
			delete state.accounts[key]
			continue
		}
		if (typeof value.key !== 'string') value.key = key
		if (typeof value.pendingTokens !== 'number') value.pendingTokens = 0
	}
}

ensureShape()

function save(): void {
	ensureShape()
	state.updatedAt = new Date().toISOString()
	liveFiles.save(state)
}

function onChange(cb: () => void): void {
	liveFiles.onChange(state, () => {
		ensureShape()
		cb()
	})
}

function accountKey(credential: Pick<Credential, '_key' | 'index'>): string {
	return credential._key ?? `openai:${credential.index ?? 0}`
}

function listSubscriptionCredentials(): Credential[] {
	return auth.listCredentials('openai').filter((credential) => credential.type === 'token')
}

function getAccount(key: string): AccountUsage | null {
	ensureShape()
	return state.accounts[key] ?? null
}

function current(): AccountUsage | null {
	ensureShape()
	if (state.currentKey) return state.accounts[state.currentKey] ?? null
	return null
}

function all(): AccountUsage[] {
	ensureShape()
	return Object.values(state.accounts).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
}

function parseWindow(raw: any): UsageWindow | undefined {
	if (!raw || typeof raw !== 'object') return undefined
	const usedPercent = Number(raw.used_percent)
	const windowSeconds = Number(raw.limit_window_seconds)
	const resetAt = Number(raw.reset_at)
	if (!Number.isFinite(usedPercent) || !Number.isFinite(windowSeconds) || !Number.isFinite(resetAt)) return undefined
	return {
		usedPercent,
		windowMinutes: Math.round(windowSeconds / 60),
		resetAt,
	}
}

function parsePayload(credential: Credential, raw: any): AccountUsage {
	const key = accountKey(credential)
	return {
		key,
		email: raw?.email || credential.email,
		index: credential.index,
		total: credential.total,
		planType: typeof raw?.plan_type === 'string' ? raw.plan_type : undefined,
		fetchedAt: new Date().toISOString(),
		primary: parseWindow(raw?.rate_limit?.primary_window),
		secondary: parseWindow(raw?.rate_limit?.secondary_window),
		pendingTokens: 0,
	}
}

function setCurrentCredential(credential: Credential | undefined): void {
	if (!credential || credential.type !== 'token') return
	const key = accountKey(credential)
	if (state.currentKey === key) return
	state.currentKey = key
	save()
}

function noteActivity(now = Date.now()): void {
	const last = state.lastActiveAt ? Date.parse(state.lastActiveAt) : 0
	if (last && now - last < config.activityWriteThrottleMs) return
	state.lastActiveAt = new Date(now).toISOString()
	save()
}

function formatResetAt(resetAt: number, now = new Date()): string {
	const d = new Date(resetAt * 1000)
	const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
	const sameDay =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate()
	if (sameDay) return time
	const date = d.toLocaleDateString([], { day: 'numeric', month: 'short' })
	return `${time} on ${date}`
}

function formatAccountLabel(account: AccountUsage): string {
	if (account.email) return account.email
	if (account.total && account.index != null) return `account ${account.index + 1}/${account.total}`
	return account.key
}

function formatPercent(account: AccountUsage, window: UsageWindow | undefined, label: string): string {
	if (!window) return `${label} ?`
	return `${label} ${Math.round(window.usedPercent)}% used (${DIM}resets ${formatResetAt(window.resetAt)}${RESET})`
}

function formatStatusText(): string {
	const accounts = all()
	if (accounts.length === 0) return 'No cached OpenAI subscription usage. Run /status again after logging in with ChatGPT.'
	const lines = ['OpenAI subscriptions:']
	for (const account of accounts) {
		const currentMark = state.currentKey === account.key ? '*' : ' '
		const head = `${currentMark} ${account.index != null && account.total ? `${account.index + 1}/${account.total}` : '-'} ${formatAccountLabel(account)}`
		const plan = account.planType ? ` (${account.planType})` : ''
		lines.push(
			`${head}${plan} · ${formatPercent(account, account.primary, '5h')} · ${formatPercent(account, account.secondary, '7d')}`,
		)
	}
	return lines.join('\n')
}

async function fetchAccountUsage(credential: Credential): Promise<AccountUsage> {
	await auth.ensureFresh('openai')
	const res = await fetch(USAGE_URL, {
		headers: { Authorization: `Bearer ${credential.value}` },
		signal: AbortSignal.timeout(config.fetchTimeoutMs),
	})
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		throw new Error(`/wham/usage ${res.status}: ${text.slice(0, 200)}`)
	}
	return parsePayload(credential, await res.json())
}

async function refreshCredential(credential: Credential, force = false): Promise<AccountUsage> {
	const key = accountKey(credential)
	const existing = getAccount(key)
	const lastFetch = existing?.fetchedAt ? Date.parse(existing.fetchedAt) : 0
	if (!force && lastFetch && Date.now() - lastFetch < config.minAutoRefreshMs) return existing!
	const next = await fetchAccountUsage(credential)
	state.accounts[key] = next
	if (!state.currentKey) state.currentKey = key
	save()
	return next
}

function findCredentialByKey(key: string): Credential | undefined {
	return listSubscriptionCredentials().find((credential) => accountKey(credential) === key)
}

async function refreshAll(force = false): Promise<AccountUsage[]> {
	const credentials = listSubscriptionCredentials()
	if (credentials.length === 0) return []
	for (const credential of credentials) {
		await refreshCredential(credential, force)
	}
	return all()
}

function recordUsage(credential: Credential | undefined, usage: { input: number; output: number } | undefined): void {
	if (!credential || credential.type !== 'token' || !usage) return
	const key = accountKey(credential)
	const account = state.accounts[key] ?? {
		key,
		email: credential.email,
		index: credential.index,
		total: credential.total,
		pendingTokens: 0,
	}
	account.pendingTokens += (usage.input ?? 0) + (usage.output ?? 0)
	state.accounts[key] = account
	save()
	void maybeRefreshCurrent()
}

function shouldRefreshByActivity(account: AccountUsage | null, now: number): boolean {
	if (!account?.fetchedAt) return true
	const lastFetch = Date.parse(account.fetchedAt)
	if (!Number.isFinite(lastFetch)) return true
	const lastActive = state.lastActiveAt ? Date.parse(state.lastActiveAt) : 0
	if (!lastActive || now - lastActive > config.activeWindowMs) return false
	return now - lastFetch >= config.activeRefreshMs
}

function shouldRefreshByTokens(account: AccountUsage | null, now: number): boolean {
	if (!account || account.pendingTokens < config.tokenRefreshThreshold) return false
	const lastFetch = account.fetchedAt ? Date.parse(account.fetchedAt) : 0
	if (!lastFetch) return true
	return now - lastFetch >= config.minAutoRefreshMs
}

async function maybeRefreshCurrent(): Promise<void> {
	if (!ipc.ownsHostLock()) return
	ensureShape()
	const key = state.currentKey
	if (!key) return
	const credential = findCredentialByKey(key)
	if (!credential) return
	const account = getAccount(key)
	const now = Date.now()
	if (!shouldRefreshByTokens(account, now) && !shouldRefreshByActivity(account, now)) return
	try {
		await refreshCredential(credential)
	} catch {}
}

let timer: ReturnType<typeof setInterval> | null = null

function start(signal?: AbortSignal): void {
	if (timer) return
	const currentCredential = auth.getCredential('openai')
	if (currentCredential?.type === 'token') setCurrentCredential(currentCredential)
	timer = setInterval(() => {
		void maybeRefreshCurrent()
	}, config.minAutoRefreshMs)
	void maybeRefreshCurrent()
	if (signal) {
		signal.addEventListener(
			'abort',
			() => {
				if (timer) clearInterval(timer)
				timer = null
			},
			{ once: true },
		)
	}
}

async function renderStatus(force = true): Promise<string> {
	const credentials = listSubscriptionCredentials()
	if (credentials.length === 0) return 'No OpenAI ChatGPT subscriptions configured.'
	try {
		await refreshAll(force)
		return formatStatusText()
	} catch (err: any) {
		const cached = formatStatusText()
		const suffix = err?.message ? String(err.message) : String(err)
		if (all().length > 0) return `${cached}\n\nRefresh failed: ${suffix}`
		return `OpenAI subscription usage unavailable: ${suffix}`
	}
}

export const openaiUsage = {
	config,
	state,
	onChange,
	save,
	all,
	current,
	noteActivity,
	setCurrentCredential,
	recordUsage,
	refreshAll,
	maybeRefreshCurrent,
	formatResetAt,
	formatStatusText,
	renderStatus,
	parsePayload,
	start,
}
