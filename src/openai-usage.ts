// OpenAI ChatGPT subscription usage via chatgpt.com/backend-api/wham/usage.

import { auth, type Credential } from './auth.ts'
import { ipc } from './ipc.ts'
import { colors } from './cli/colors.ts'
import { STATE_DIR } from './state.ts'
import { liveFiles } from './utils/live-file.ts'
import { oklch } from './utils/oklch.ts'
import { subscriptionUsage } from './subscription-usage.ts'

const CACHE_PATH = `${STATE_DIR}/openai-usage.ason`
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

const BAR_PARTIALS = ['', '▁', '▂', '▃', '▄', '▅', '▆', '▇']
const BAR_FILL_FG = oklch.toFg(0.84, 0, 0)
const BAR_EMPTY_BG = oklch.toBg(0.36, 0, 0)

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

interface UsageState {
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
	progressBarWidth: 14,
}

const runtime = {
	initialized: false,
}

function defaultState(): UsageState {
	return {
		currentKey: '',
		lastActiveAt: '',
		updatedAt: '',
		accounts: {},
	}
}

let state: UsageState = defaultState()

function fix(): void {
	if (typeof openaiUsage.state.currentKey !== 'string') openaiUsage.state.currentKey = ''
	if (typeof openaiUsage.state.lastActiveAt !== 'string') openaiUsage.state.lastActiveAt = ''
	if (typeof openaiUsage.state.updatedAt !== 'string') openaiUsage.state.updatedAt = ''
	if (!openaiUsage.state.accounts || typeof openaiUsage.state.accounts !== 'object') openaiUsage.state.accounts = {}
	for (const [key, account] of Object.entries(openaiUsage.state.accounts)) {
		if (!account || typeof account !== 'object') {
			delete openaiUsage.state.accounts[key]
			continue
		}
		if (typeof account.key !== 'string') account.key = key
		if (typeof account.pendingTokens !== 'number') account.pendingTokens = 0
	}
}

function init(): void {
	if (runtime.initialized) return
	runtime.initialized = true
	openaiUsage.state = liveFiles.liveFile(CACHE_PATH, defaultState()) as UsageState
	fix()
}

function save(): void {
	openaiUsage.init()
	fix()
	openaiUsage.state.updatedAt = new Date().toISOString()
	liveFiles.save(openaiUsage.state)
}

function onChange(cb: () => void): void {
	openaiUsage.init()
	liveFiles.onChange(openaiUsage.state, () => {
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
	openaiUsage.init()
	fix()
	return openaiUsage.state.currentKey ? openaiUsage.state.accounts[openaiUsage.state.currentKey] ?? null : null
}

function all(): AccountUsage[] {
	openaiUsage.init()
	fix()
	return Object.values(openaiUsage.state.accounts).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
}

function setCurrentCredential(credential: Credential | undefined): void {
	openaiUsage.init()
	if (!credential || credential.type !== 'token') return
	const key = keyOf(credential)
	if (openaiUsage.state.currentKey === key) return
	openaiUsage.state.currentKey = key
	save()
}

function noteActivity(now = Date.now()): void {
	openaiUsage.init()
	const last = openaiUsage.state.lastActiveAt ? Date.parse(openaiUsage.state.lastActiveAt) : 0
	if (last && now - last < config.activityWriteThrottleMs) return
	openaiUsage.state.lastActiveAt = new Date(now).toISOString()
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

function displayAccount(account: AccountUsage): string {
	const raw = account.email || (account.total && account.index != null ? `account ${account.index + 1}/${account.total}` : account.key)
	const who = subscriptionUsage.config.censorEmails && account.email ? subscriptionUsage.censorEmail(account.email) : raw
	const plan = account.planType ? ` (${account.planType})` : ''
	return `${who}${plan}`
}

function displaySlot(account: AccountUsage): string {
	const slot = account.index != null && account.total ? `${account.index + 1}/${account.total}` : '-'
	return openaiUsage.state.currentKey === account.key ? `${slot} *` : slot
}

function usageBar(usedPercent: number): string {
	const width = Math.max(1, Math.round(config.progressBarWidth))
	const clamped = Math.max(0, Math.min(100, usedPercent))
	const totalEighths = Math.round((clamped / 100) * width * 8)
	const full = Math.floor(totalEighths / 8)
	const partial = totalEighths % 8
	const empty = width - full - (partial > 0 ? 1 : 0)
	const fill = `${'█'.repeat(full)}${BAR_PARTIALS[partial] ?? ''}`
	const reset = `${colors.info.fg}${colors.info.bg}`
	return `[${BAR_EMPTY_BG}${BAR_FILL_FG}${fill}${BAR_EMPTY_BG}${' '.repeat(Math.max(0, empty))}${reset}]`
}

function formatWindowText(window: UsageWindow | undefined): string {
	if (!window) return '?'
	return `${Math.round(window.usedPercent)}% used (resets ${formatResetAt(window.resetAt)})`
}

function formatWindowCell(window: UsageWindow | undefined): string {
	if (!window) return '?'
	return `${usageBar(window.usedPercent)}<br>${formatWindowText(window)}`
}

function formatStatusText(): string {
	const accounts = all()
	if (accounts.length === 0) return 'No cached OpenAI subscription usage. Run /status again after logging in with ChatGPT.'
	const lines = [
		'OpenAI subscriptions:',
		'',
		'| Slot | Account | 5h | 7d |',
		'|---|---|---|---|',
	]
	for (const account of accounts) {
		lines.push(`| ${displaySlot(account)} | ${displayAccount(account)} | ${formatWindowCell(account.primary)} | ${formatWindowCell(account.secondary)} |`)
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
	openaiUsage.init()
	const key = keyOf(credential)
	const existing = openaiUsage.state.accounts[key]
	const lastFetch = existing?.fetchedAt ? Date.parse(existing.fetchedAt) : 0
	if (!force && existing && lastFetch && Date.now() - lastFetch < config.minAutoRefreshMs) return existing
	openaiUsage.state.accounts[key] = await fetchUsage(credential)
	if (!openaiUsage.state.currentKey) openaiUsage.state.currentKey = key
	save()
	return openaiUsage.state.accounts[key]!
}

async function refreshAll(force = false): Promise<AccountUsage[]> {
	openaiUsage.init()
	for (const credential of credentials()) await refreshCredential(credential, force)
	return all()
}

function recordUsage(credential: Credential | undefined, usage: { input: number; output: number } | undefined): void {
	openaiUsage.init()
	if (!credential || credential.type !== 'token' || !usage) return
	const key = keyOf(credential)
	const account = openaiUsage.state.accounts[key] ?? {
		key,
		email: credential.email,
		index: credential.index,
		total: credential.total,
		pendingTokens: 0,
	}
	account.pendingTokens += (usage.input ?? 0) + (usage.output ?? 0)
	openaiUsage.state.accounts[key] = account
	save()
	void maybeRefreshCurrent()
}

async function maybeRefreshCurrent(): Promise<void> {
	openaiUsage.init()
	if (!ipc.ownsHostLock() || !openaiUsage.state.currentKey) return
	const credential = credentials().find((item) => keyOf(item) === openaiUsage.state.currentKey)
	if (!credential) return
	const account = openaiUsage.state.accounts[openaiUsage.state.currentKey] ?? null
	const now = Date.now()
	const lastFetch = account?.fetchedAt ? Date.parse(account.fetchedAt) : 0
	const lastActive = openaiUsage.state.lastActiveAt ? Date.parse(openaiUsage.state.lastActiveAt) : 0
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
	openaiUsage.init()
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
	openaiUsage.init()
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
	runtime,
	state,
	init,
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
