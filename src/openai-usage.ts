// OpenAI ChatGPT subscription usage via chatgpt.com/backend-api/wham/usage.

import { auth, type Credential } from './auth.ts'
import { ipc } from './ipc.ts'
import { STATE_DIR } from './state.ts'
import { liveFiles } from './utils/live-file.ts'

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

const config = {
	// Automatic refreshes should be quiet. /status bypasses this floor.
	minAutoRefreshMs: 60_000,
	activeWindowMs: 5 * 60_000,
	activeRefreshMs: 10 * 60_000,
	tokenRefreshThreshold: 100_000,
	activityWriteThrottleMs: 60_000,
	fetchTimeoutMs: 10_000,
}

const state = liveFiles.liveFile(CACHE_PATH, {
	currentKey: '',
	lastActiveAt: '',
	updatedAt: '',
	accounts: {} as Record<string, AccountUsage>,
})

function fix(): void {
	if (typeof state.currentKey !== 'string') state.currentKey = ''
	if (typeof state.lastActiveAt !== 'string') state.lastActiveAt = ''
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
	return credential._key ?? `openai:${credential.index ?? 0}`
}

function credentials(): Credential[] {
	return auth.listCredentials('openai').filter((credential) => credential.type === 'token')
}

function parseWindow(raw: any): UsageWindow | undefined {
	const usedPercent = Number(raw?.used_percent)
	const windowSeconds = Number(raw?.limit_window_seconds)
	const resetAt = Number(raw?.reset_at)
	if (!Number.isFinite(usedPercent) || !Number.isFinite(windowSeconds) || !Number.isFinite(resetAt)) return
	return { usedPercent, windowMinutes: Math.round(windowSeconds / 60), resetAt }
}

function parsePayload(credential: Credential, raw: any): AccountUsage {
	return {
		key: keyOf(credential),
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
	return `${time} on ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}`
}

function formatStatusText(): string {
	const accounts = all()
	if (accounts.length === 0) return 'No cached OpenAI subscription usage. Run /status again after logging in with ChatGPT.'
	const lines = ['OpenAI subscriptions:']
	for (const account of accounts) {
		const marker = state.currentKey === account.key ? '*' : ' '
		const who = account.email || (account.total && account.index != null ? `account ${account.index + 1}/${account.total}` : account.key)
		const slot = account.index != null && account.total ? `${account.index + 1}/${account.total}` : '-'
		const plan = account.planType ? ` (${account.planType})` : ''
		const primary = account.primary
			? `5h ${Math.round(account.primary.usedPercent)}% used (${DIM}resets ${formatResetAt(account.primary.resetAt)}${RESET})`
			: '5h ?'
		const secondary = account.secondary
			? `7d ${Math.round(account.secondary.usedPercent)}% used (${DIM}resets ${formatResetAt(account.secondary.resetAt)}${RESET})`
			: '7d ?'
		lines.push(`${marker} ${slot} ${who}${plan} · ${primary} · ${secondary}`)
	}
	return lines.join('\n')
}

async function fetchUsage(credential: Credential): Promise<AccountUsage> {
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
	const key = keyOf(credential)
	const existing = state.accounts[key]
	const lastFetch = existing?.fetchedAt ? Date.parse(existing.fetchedAt) : 0
	if (!force && existing && lastFetch && Date.now() - lastFetch < config.minAutoRefreshMs) return existing
	state.accounts[key] = await fetchUsage(credential)
	if (!state.currentKey) state.currentKey = key
	save()
	return state.accounts[key]!
}

async function refreshAll(force = false): Promise<AccountUsage[]> {
	for (const credential of credentials()) await refreshCredential(credential, force)
	return all()
}

function recordUsage(credential: Credential | undefined, usage: { input: number; output: number } | undefined): void {
	if (!credential || credential.type !== 'token' || !usage) return
	const key = keyOf(credential)
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

async function maybeRefreshCurrent(): Promise<void> {
	if (!ipc.ownsHostLock() || !state.currentKey) return
	const credential = credentials().find((item) => keyOf(item) === state.currentKey)
	if (!credential) return
	const account = state.accounts[state.currentKey] ?? null
	const now = Date.now()
	const lastFetch = account?.fetchedAt ? Date.parse(account.fetchedAt) : 0
	const lastActive = state.lastActiveAt ? Date.parse(state.lastActiveAt) : 0
	const byTokens = !!account && account.pendingTokens >= config.tokenRefreshThreshold && (!lastFetch || now - lastFetch >= config.minAutoRefreshMs)
	const byActivity = !account?.fetchedAt || !Number.isFinite(lastFetch)
		? true
		: !!lastActive && now - lastActive <= config.activeWindowMs && now - lastFetch >= config.activeRefreshMs
	if (!byTokens && !byActivity) return
	try {
		await refreshCredential(credential)
	} catch {}
}

let timer: ReturnType<typeof setInterval> | null = null

function start(signal?: AbortSignal): void {
	if (timer) return
	const credential = auth.getCredential('openai')
	if (credential?.type === 'token') setCurrentCredential(credential)
	timer = setInterval(() => {
		void maybeRefreshCurrent()
	}, config.minAutoRefreshMs)
	void maybeRefreshCurrent()
	signal?.addEventListener('abort', () => {
		if (!timer) return
		clearInterval(timer)
		timer = null
	}, { once: true })
}

async function renderStatus(force = true): Promise<string> {
	if (credentials().length === 0) return 'No OpenAI ChatGPT subscriptions configured.'
	try {
		await refreshAll(force)
		return formatStatusText()
	} catch (err: any) {
		const suffix = err?.message ? String(err.message) : String(err)
		return all().length > 0 ? `${formatStatusText()}\n\nRefresh failed: ${suffix}` : `OpenAI subscription usage unavailable: ${suffix}`
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
