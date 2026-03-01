import { randomBytes } from 'crypto'
import { resolve } from 'path'
import {
	appendCommand as appendBusCommand,
	appendEvent,
	readRecentEvents,
	readState,
	tailEvents,
	updateState,
} from '../ipc.ts'

import * as tui from './tui.ts'
import {
	CTRL_C,
	flashHeader,
	getInputDraft,
	getInputHistory,
	getOutputSnapshot,
	setActivityLine,
	setEscHandler,
	setInputDraft,
	setInputEchoFilter,
	setInputHistory,
	setInputKeyHandler,
	setMaxPromptLines,
	setUserCursorMode,
	setHalState,
	setCursorBlink,
	type HalState,
	type HalState,
	setOutputSnapshot,
	setStatusLine,
	setTitleBar,
	setDoubleEnterHandler,
	setTabCompleter,
} from './tui.ts'

import {
	makeCommand,
	type CommandType,
	type RuntimeCommand,
	type RuntimeEvent,
	type SessionInfo,
} from '../protocol.ts'
import { pushEvent, pushFragment, resetFormat, stripAnsi, setShowTimestamps } from './format/index.ts'
import {
	ALT_DIGIT_KEYS,
	CTRL_DIGIT_KEYS,
	CTRL_F_KEYS,
	CTRL_NEXT_TAB,
	CTRL_PREV_TAB,
	CTRL_T_KEYS,
	CTRL_W_KEYS,
} from './keys.ts'
import { COMMAND_NAMES, handleCommand, isExit } from './commands.ts'
import { HAL_DIR, LAUNCH_CWD } from '../state.ts'
import {
	loadConversation,
	loadInputHistory,
	replayConversationEvents,
	saveDraft,
	loadDraft,
	loadSessionRegistry,
	saveSessionRegistry,
} from '../session.ts'
import { countSourceStats } from '../utils/cloc.ts'

import { loadConfig, mergedModelAliases, modelIdForModel, resolveModel } from '../config.ts'
import { loadActiveTheme } from './format/theme.ts'
import { selfMode } from '../args.ts'
import {
	activityBarText,
	tabDisplayNames,
	titleBarText,
	sessionName,
	createTabState,
	type CliTab,
} from './tab.ts'

function fmtK(tokens: number): string {
	return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}
function fmtContext(ctx: { used: number; max: number; estimated?: boolean }): string {
	const pct = ctx.max > 0 ? ((ctx.used / ctx.max) * 100).toFixed(1) : '0'
	return `${ctx.estimated ? '~' : ''}${pct}%/${fmtK(ctx.max)}`
}
function deriveHalState(tab: CliTab): HalState {
	if (!tab.busy) return 'idle'
	const a = tab.activity
	if (a.startsWith('Thinking')) return 'thinking'
	if (a.startsWith('Calling tool') || a.startsWith('Running')) return 'tool_call'
	if (a.startsWith('Error') || a.startsWith('Retrying')) return 'error'
	return 'writing'
}
const MODEL_NAMES: [RegExp, string][] = [
	[/^claude-opus-4-6/, 'Opus 4.6'], [/^claude-opus-4-5/, 'Opus 4.5'],
	[/^claude-sonnet-4-6/, 'Sonnet 4.6'], [/^claude-sonnet-4-5/, 'Sonnet 4.5'],
	[/^claude-sonnet-4/, 'Sonnet 4'],
	[/^gpt-5\.3-codex/, 'Codex 5.3'], [/^gpt-5\.2-codex/, 'Codex 5.2'], [/^gpt-5\.1-codex/, 'Codex 5.1'],
	[/^gpt-5(?:[.-]|$)/, 'GPT-5'], [/^gpt-4\.1(?:[.-]|$)/, 'GPT-4.1'], [/^gpt-4o(?:[.-]|$)/, 'GPT-4o'],
	[/^o1(?:[.-]|$)/, 'o1'], [/^o3(?:[.-]|$)/, 'o3'],
]
function modelDisplayName(model: string): string {
	const id = modelIdForModel(resolveModel(model))
	return MODEL_NAMES.find(([re]) => re.test(id))?.[1] ?? id
}

export class Client {
	async command(type: CommandType, text?: string): Promise<void> { await appendCommand(type, text) }
	log(kind: string, text: string): void { pushLocal(kind, text) }
	async prompt(message: string, promptStr: string): Promise<string | null> { return tui.prompt(message, promptStr) }
	getTranscript(): string { return tui.getOutputSnapshot() }
	clear(): void { tui.clearOutput() }
	async closeTab(): Promise<void> { await closeActiveTab() }
	async openSession(sessionId: string, workingDir: string): Promise<void> { await openSessionTab(sessionId, workingDir) }
	getActiveSessionIds(): string[] { return tabs.map((t) => t.sessionId) }
}

const ALL_MODELS = [...new Set([...Object.keys(mergedModelAliases()), ...Object.values(mergedModelAliases())]) ]
const TAB_ACTIVE = '\x1b[97m', TAB_INACTIVE = '\x1b[38;5;245m', TAB_RESET = '\x1b[0m'

function normalizeCommandInput(input: string): string {
	return stripAnsi(input).replace(/[\u0000-\u001f\u007f]/g, '').trim().toLowerCase()
}

function completeInput(prefix: string): string[] {
	if (prefix.startsWith('/') && !prefix.includes(' '))
		return COMMAND_NAMES.map((c) => '/' + c).filter((c) => c.startsWith(prefix))
	if (prefix.startsWith('/model '))
		return ALL_MODELS.filter((m) => m.startsWith(prefix.slice(7))).map((m) => `/model ${m}`)
	return []
}

// Module state
let source: RuntimeCommand['source']
let isOwner = false, stopped = false, lastContextStatus: string | null = null
let roleLabel = '', wasBusyOnLastSubmit = false
const client = new Client()
let tabs: CliTab[] = [], activeTabIndex = 0, launchCwd = ''
let pendingForkOutput: string | null = null, pendingForkSwitch = false
let tabHasActivity = new Set<string>()

export function init(src: RuntimeCommand['source'], owner: boolean): void {
	source = src; isOwner = owner; launchCwd = resolve(LAUNCH_CWD)
	const config = loadConfig()
	setMaxPromptLines(config.maxPromptLines); setUserCursorMode(config.userCursor); loadActiveTheme(HAL_DIR, config.theme)
	setCursorBlink(config.cursorBlinkIdle, config.cursorBlinkBusy, config.cursorBlinkUser)
	if (config.timestamps) setShowTimestamps(true)
}

export function promoteToOwner(): void {
	isOwner = true; roleLabel = 'owner'
	pushLocal('local.status', `[promoted] this process (pid ${process.pid}) is now the owner`)
	renderBusyStatus()
}

let onOwnerReleased: (() => void) | null = null
export function setOwnerReleaseHandler(handler: (() => void) | null): void { onOwnerReleased = handler }

export async function start(options?: { startupEpoch?: number | null }): Promise<number> {
	tui.init()
	setTabCompleter(completeInput)
	setEscHandler(() => handleEsc())
	setDoubleEnterHandler(() => handleDoubleEnter())
	setInputKeyHandler((key) => handleInputKey(key))
	setInputEchoFilter((value) => !isExit(normalizeCommandInput(value)))
	roleLabel = isOwner ? 'owner' : 'client'

	const config = loadConfig()
	pushLocal('local.info', `HAL ${roleLabel} (pid ${process.pid})`)
	if (config.debug?.recordEverything)
		pushLocal('local.info', 'debug.recordEverything is active — use /bug <report> to report and fix immediately')
	pushLocal('local.info', '/q or Ctrl-D to quit · Ctrl-V to paste images · /help for more')

	await bootstrapState()
	if (selfMode) applySelfMode()
	if (options?.startupEpoch) {
		const elapsed = Date.now() - options.startupEpoch
		const level = elapsed > 100 ? 'local.warn' : 'local.status'
		void countSourceStats(HAL_DIR).then(({ files, lines }) => {
			pushLocal(level, `[perf] startup: ${elapsed}ms (${files} modules, ${lines} loc)`)
		})
	}

	void (async () => {
		try {
			for await (const event of tailEvents()) { if (stopped) break; render(event) }
		} catch (e: any) { if (!stopped) pushLocal('local.error', `[event-tail] ${e.message || e}`) }
	})()

	let restart = false
	try {
		while (!stopped) {
			const input = await tui.input(' ')
			if (input === CTRL_C) { restart = true; break }
			if (input === null) break
			const trimmed = input.trim(), normalized = normalizeCommandInput(input)
			if (!trimmed) { if (activeTab()?.paused) await client.command('resume'); continue }
			if (isExit(normalized)) break
			wasBusyOnLastSubmit = activeTab()?.busy ?? false
			await handleCommand(input, client)
			const tab = activeTab()
			if (tab) { tab.inputHistory = getInputHistory(); saveDraft(tab.sessionId, '').catch(() => {}) }
		}
	} finally {
		captureActiveOutput()
		const exitSessionId = activeTab()?.sessionId ?? null
		const exitTasks: Promise<unknown>[] = tabs.map((tab) => saveDraft(tab.sessionId, tab.inputDraft).catch(() => {}))
		if (exitSessionId) {
			exitTasks.push(updateState((s) => { s.activeSessionId = exitSessionId }).catch(() => {}))
			exitTasks.push(loadSessionRegistry().then((reg) => {
				reg.activeSessionId = exitSessionId; return saveSessionRegistry(reg)
			}).catch(() => {}))
		}
		await Promise.all(exitTasks)
		setInputKeyHandler(null); setEscHandler(null); setDoubleEnterHandler(null); setInputEchoFilter(null)
		stopped = true
		try { tui.cleanup() } catch {}
	}
	return restart ? 100 : 0
}

// Internal helpers

function activeTab(): CliTab | null { return tabs[activeTabIndex] ?? null }
function pushLocal(kind: string, text: string): void { tui.write(pushFragment(kind, text)) }

function newTabState(sessionId: string, workingDir: string): CliTab {
	return createTabState({
		sessionId, workingDir,
		name: sessionName({ id: sessionId, name: undefined, workingDir }),
		modelLabel: modelDisplayName(loadConfig().defaultModel),
	})
}

function ensureFallbackTab(activeSessionId: string | null = null): void {
	if (tabs.length > 0) return
	tabs = [newTabState(activeSessionId || 's-default', launchCwd)]
	activeTabIndex = 0; tabHasActivity = new Set()
	applyActiveTabSnapshot(false)
}

function captureActiveOutput(): void {
	const active = activeTab(); if (!active) return
	active.output = getOutputSnapshot(); active.inputHistory = getInputHistory()
	const draft = getInputDraft(); active.inputDraft = draft.text; active.inputCursor = draft.cursor
}

function applyActiveTabSnapshot(clearWhenEmpty: boolean): void {
	const active = activeTab(); if (!active) return
	resetFormat(); lastContextStatus = active.contextStatus
	setActivityLine(activityBarText(active)); setHalState(deriveHalState(active)); setTitleBar(titleBarText(active))
	setInputHistory(active.inputHistory); setInputDraft(active.inputDraft, active.inputCursor)
	if (clearWhenEmpty) { active.output.length > 0 ? tui.replaceOutput(active.output) : tui.clearOutput() }
	else if (active.output.length > 0) setOutputSnapshot(active.output)
	ensureTabBootstrap(active); renderBusyStatus()
}

function ensureTabBootstrap(tab: CliTab): void {
	if (!tab || tab.bootstrapSent || tab.output.trim().length > 0) return
	tab.bootstrapSent = true
	appendBusCommand(makeCommand('cd', source, tab.workingDir, tab.sessionId)).catch(() => {})
}

function switchToTab(index: number): void {
	if (index < 0 || index >= tabs.length || index === activeTabIndex) return
	captureActiveOutput(); activeTabIndex = index; applyActiveTabSnapshot(true)
}

function handleInputKey(key: string): boolean {
	if (CTRL_T_KEYS.has(key)) { void createTab(); return true }
	if (CTRL_W_KEYS.has(key)) { void closeActiveTab(); return true }
	if (CTRL_F_KEYS.has(key)) { void forkTab(); return true }
	const digit = CTRL_DIGIT_KEYS[key] ?? ALT_DIGIT_KEYS[key]
	if (digit) { switchToTab(digit - 1); return true }
	if (CTRL_PREV_TAB.has(key)) { switchToTab(activeTabIndex > 0 ? activeTabIndex - 1 : tabs.length - 1); return true }
	if (CTRL_NEXT_TAB.has(key)) { switchToTab(activeTabIndex < tabs.length - 1 ? activeTabIndex + 1 : 0); return true }
	return false
}

function makeLocalSessionId(): string {
	let id = ''; do { id = `s-${randomBytes(3).toString('hex')}` } while (tabs.some((t) => t.sessionId === id))
	return id
}

async function createTab(): Promise<void> {
	if (tabs.length >= 9) { pushLocal('local.warn', '[tabs] max 9 tabs'); return }
	captureActiveOutput()
	const sessionId = makeLocalSessionId()
	tabs.push(newTabState(sessionId, launchCwd))
	activeTabIndex = tabs.length - 1; applyActiveTabSnapshot(true)
	pushLocal('local.tab', `[tab] opened ${activeTabIndex + 1}: ${launchCwd}`)
	let hint = '[tabs] Switch: Alt-1..9 | Cycle: Ctrl-P/N | Fork: Ctrl-F | Close: Ctrl-W'
	if (process.platform === 'darwin') {
		const term = process.env.TERM_PROGRAM ?? ''
		if (term === 'iTerm.app') hint += " | iTerm2: set Preferences > Profiles > Keys > Option Key to 'Esc+'"
		else if (term === 'Apple_Terminal') hint += " | Terminal.app: enable Preferences > Profiles > Keyboard > 'Use Option as Meta key'"
	}
	pushLocal('local.tabs', hint)
}

async function openSessionTab(sessionId: string, workingDir: string): Promise<void> {
	if (tabs.length >= 9) { pushLocal('local.warn', '[tabs] max 9 tabs'); return }
	const existing = tabs.findIndex((t) => t.sessionId === sessionId)
	if (existing >= 0) { switchToTab(existing); pushLocal('local.tab', `[restore] switched to existing tab ${existing + 1}`); return }
	captureActiveOutput()
	const inputHistory = await loadInputHistory(sessionId)
	tabs.push({ ...newTabState(sessionId, workingDir), inputHistory })
	activeTabIndex = tabs.length - 1
	const added = tabs[activeTabIndex]
	const history = await loadConversation(sessionId)
	added.output = renderConversationHistory(sessionId, history)
	const replayCount = replayConversationEvents(history).length
	applyActiveTabSnapshot(true)
	pushLocal('local.tab', `[restore] opened session ${sessionId} in tab ${activeTabIndex + 1} (${replayCount} event${replayCount === 1 ? '' : 's'} replayed)`)
}

async function closeActiveTab(): Promise<void> {
	const active = activeTab(); if (!active) return
	await appendBusCommand(makeCommand('close', source, undefined, active.sessionId))
	if (tabs.length <= 1) {
		await appendEvent({
			id: `${Date.now()}-${process.pid}-close-last`, type: 'sessions',
			activeSessionId: null, sessions: [], createdAt: new Date().toISOString(),
		})
		stopped = true; tui.cancelInput(); return
	}
	pushLocal('local.queue', `close tab ${active.sessionId.slice(0, 8)}`)
}

async function forkTab(): Promise<void> {
	const active = activeTab(); if (!active) return
	if (tabs.length >= 9) { pushLocal('local.warn', '[tabs] max 9 tabs'); return }
	captureActiveOutput()
	pendingForkOutput = active.output; pendingForkSwitch = true
	await appendBusCommand(makeCommand('fork', source, undefined, active.sessionId))
	pushLocal('local.queue', 'fork')
}

function syncTabsFromSessions(
	sessions: SessionInfo[], preferredActiveSessionId: string | null,
	options: { preserveActiveOutput?: boolean; render?: boolean; bootstrap?: boolean } = {},
): void {
	if (!Array.isArray(sessions) || sessions.length === 0) { stopped = true; tui.cancelInput(); return }
	const preserve = options.preserveActiveOutput ?? true
	if (preserve) captureActiveOutput()
	const previousById = new Map(tabs.map((t) => [t.sessionId, t]))
	const previousActive = activeTab()?.sessionId ?? null
	const previousActiveIndex = activeTabIndex
	const forkOutput = pendingForkOutput, switchToFork = pendingForkSwitch
	pendingForkOutput = null; pendingForkSwitch = false
	let forkedSessionId: string | null = null

	tabs = sessions.slice(0, 9).map((session) => {
		const existing = previousById.get(session.id)
		const isNewFromFork = !existing && forkOutput !== null
		if (isNewFromFork) forkedSessionId = session.id
		return {
			...createTabState({
				sessionId: session.id, workingDir: session.workingDir,
				name: sessionName(session),
				modelLabel: modelDisplayName(session.model ?? existing?.modelLabel ?? loadConfig().defaultModel),
			}),
			topic: session.topic ?? existing?.topic ?? '',
			output: preserve ? (existing?.output ?? (isNewFromFork ? forkOutput : '')) : '',
			contextStatus: preserve ? (existing?.contextStatus ?? null) : null,
			activity: preserve ? (existing?.activity ?? '') : '',
			busy: preserve ? (existing?.busy ?? false) : false,
			paused: preserve ? (existing?.paused ?? false) : false,
			inputHistory: existing?.inputHistory ?? [],
			inputDraft: existing?.inputDraft ?? '',
			inputCursor: existing?.inputCursor ?? 0,
			bootstrapSent: existing?.bootstrapSent ?? false,
		}
	})
	tabHasActivity = new Set([...tabHasActivity].filter((id) => tabs.some((t) => t.sessionId === id)))

	const previousStillExists = previousActive && tabs.some((t) => t.sessionId === previousActive)
	let targetSessionId: string
	if (switchToFork && forkedSessionId) targetSessionId = forkedSessionId
	else if (previousStillExists) targetSessionId = previousActive!
	else if (previousActive) {
		const idx = previousActiveIndex > 0 ? previousActiveIndex - 1 : 0
		targetSessionId = tabs[Math.min(idx, tabs.length - 1)]?.sessionId ?? tabs[0].sessionId
	} else {
		targetSessionId = preferredActiveSessionId && tabs.some((t) => t.sessionId === preferredActiveSessionId)
			? preferredActiveSessionId : tabs[0].sessionId
	}
	activeTabIndex = Math.max(0, tabs.findIndex((t) => t.sessionId === targetSessionId))
	if (options.render ?? true) applyActiveTabSnapshot(targetSessionId !== previousActive)
	if (options.bootstrap ?? true) for (const tab of tabs) ensureTabBootstrap(tab)
}

function renderConversationHistory(sessionId: string, events: Awaited<ReturnType<typeof loadConversation>>): string {
	resetFormat(sessionId)
	let output = ''
	let prevType = ''
	for (const event of replayConversationEvents(events)) {
		if (event.type === 'user') {
			output += pushFragment('prompt', event.text, sessionId)
		} else {
			// Blank line after prompt block for breathing room
			if (prevType === 'user') output += '\n'
			output += event.text + '\n'
		}
		prevType = event.type
	}
	return output
}

async function hydrateTabsFromConversation(): Promise<Map<string, number>> {
	const replayed = new Map<string, number>()
	await Promise.all(tabs.map(async (tab) => {
		if (tab.output.trim().length > 0) return
		const events = await loadConversation(tab.sessionId)
		tab.output = renderConversationHistory(tab.sessionId, events)
		replayed.set(tab.sessionId, replayConversationEvents(events).length)
	}))
	return replayed
}

function findTabBySessionId(sessionId: string): CliTab | null { return tabs.find((t) => t.sessionId === sessionId) ?? null }

function findOrCreateTabBySessionId(sessionId: string): CliTab | null {
	const existing = findTabBySessionId(sessionId)
	if (existing) return existing
	if (tabs.length >= 9) return null
	const tab = newTabState(sessionId, launchCwd)
	tabs.push(tab); renderBusyStatus()
	return tab
}

function handleEsc(): void {
	const active = activeTab()
	if (!active || !active.busy) return
	appendBusCommand(makeCommand('pause', source, undefined, active.sessionId)).catch(() => {})
	flashHeader('\x1b[33mpausing...\x1b[0m')
	setActivityLine(`Paused • ${active.modelLabel} — Enter to resume, /queue to inspect, /drop to clear`)
}

function handleDoubleEnter(): void {
	const active = activeTab()
	if (!active || !wasBusyOnLastSubmit) return
	appendBusCommand(makeCommand('steer', source, undefined, active.sessionId)).catch(() => {})
}

async function bootstrapState(): Promise<void> {
	try {
		const state = await readState()
		const busySet = new Set(state.busySessionIds ?? [])
		if (Array.isArray(state.sessions) && state.sessions.length > 0)
			syncTabsFromSessions(state.sessions, state.activeSessionId ?? null, { preserveActiveOutput: false, render: false, bootstrap: false })
		else ensureFallbackTab(state.activeSessionId ?? null)
		for (const tab of tabs) tab.busy = busySet.has(tab.sessionId)

		const recent = await readRecentEvents(500)
		const replayCounts = await hydrateTabsFromConversation()
		for (const [sessionId, count] of replayCounts)
			if (count > 0) pushLocal('local.status', `[history] restored ${count} event${count === 1 ? '' : 's'} for ${sessionId}`)
		for (const event of recent) {
			if (event.type !== 'status' || !event.context) continue
			const sessionId = event.sessionId ?? activeTab()?.sessionId ?? null
			if (!sessionId) continue
			const tab = findTabBySessionId(sessionId)
			if (tab) tab.contextStatus = fmtContext(event.context)
		}
		await Promise.all(tabs.map(async (tab) => {
			tab.inputHistory = await loadInputHistory(tab.sessionId)
			tab.inputDraft = await loadDraft(tab.sessionId)
		}))
		applyActiveTabSnapshot(true)
		for (const tab of tabs) ensureTabBootstrap(tab)
		renderBusyStatus()
	} catch (e: any) {
		pushLocal('local.status', `bootstrap failed: ${e.message || e}`)
		ensureFallbackTab(null); renderBusyStatus()
	}
}

/** Parse context percentage from contextStatus string (e.g. "~5.2%/200k" → 5.2, null → null) */
export function parseContextPct(status: string | null): number | null {
	if (!status) return null
	const m = status.match(/~?(\d+(?:\.\d+)?)%/)
	return m ? parseFloat(m[1]) : null
}

function applySelfMode(): void {
	const candidate = tabs.findIndex((t) => !t.busy && (parseContextPct(t.contextStatus) ?? 0) < 10)
	if (candidate >= 0 && candidate !== activeTabIndex) {
		switchToTab(candidate); pushLocal('local.status', `[self] switched to tab ${candidate + 1} (idle, low context)`)
	} else if (candidate < 0) {
		void createTab().then(() => pushLocal('local.status', '[self] opened new tab (no idle low-context session found)'))
	}
}

function activeSessionId(): string | null { return activeTab()?.sessionId ?? null }

async function appendCommand(type: RuntimeCommand['type'], text?: string): Promise<void> {
	await appendBusCommand(makeCommand(type, source, text, activeSessionId()))
}

function renderEventToTab(tab: CliTab, event: RuntimeEvent, renderToScreen: boolean): void {
	if (event.type === 'line' && event.level === 'meta' && renderToScreen && tab === activeTab()) renderBusyStatus()
	const text = pushEvent(event, source); if (!text) return
	if (renderToScreen) { tui.write(text); tabHasActivity.delete(tab.sessionId) }
	else { tab.output += text; tabHasActivity.add(tab.sessionId) }
}

function render(event: RuntimeEvent): void {
	if (event.type === 'line' && event.text === '[owner-released]') { if (onOwnerReleased) onOwnerReleased(); return }
	if (event.type === 'sessions') { syncTabsFromSessions(event.sessions, event.activeSessionId ?? null); return }

	if (event.type === 'status') {
		const isPartial = ('activity' in event && event.activity !== undefined) ||
			('context' in event && event.context !== undefined)
		if (isPartial) {
			if ('activity' in event && event.activity !== undefined) {
				const tab = event.sessionId ? findTabBySessionId(event.sessionId) : null
				if (tab) tab.activity = event.activity!
			}
		} else {
			const busySet = new Set(event.busySessionIds ?? []), pausedSet = new Set(event.pausedSessionIds ?? [])
			for (const tab of tabs) {
				const wasBusy = tab.busy
				tab.busy = busySet.has(tab.sessionId); tab.paused = pausedSet.has(tab.sessionId)
				if (!tab.busy && wasBusy) tab.activity = ''
			}
		}
		const active = activeTab()
		if (active) { setActivityLine(activityBarText(active)); setHalState(deriveHalState(active)) }
		if (event.context) {
			const tab = event.sessionId ? findTabBySessionId(event.sessionId) : activeTab()
			if (tab) { tab.contextStatus = fmtContext(event.context); if (tab === activeTab()) lastContextStatus = tab.contextStatus }
		}
		renderBusyStatus(); return
	}

	const sessionId = 'sessionId' in event ? event.sessionId : null
	if (!sessionId) { const active = activeTab(); if (active) renderEventToTab(active, event, true); return }
	const tab = (event.type === 'line' || event.type === 'chunk' || event.type === 'prompt')
		? findOrCreateTabBySessionId(sessionId) : findTabBySessionId(sessionId)
	if (!tab) return
	const isActive = tab === activeTab()
	if (isActive) tabHasActivity.delete(tab.sessionId)
	renderEventToTab(tab, event, isActive)
	if (isActive) renderBusyStatus()
}

function renderTabsForStatus(): string {
	if (tabs.length === 0) return ''
	const labels = tabDisplayNames(tabs.slice(0, 9))
	return tabs.slice(0, 9).map((tab, i) => {
		const act = i !== activeTabIndex && tabHasActivity.has(tab.sessionId) ? '*' : ' '
		const text = `${i + 1}${act}${labels[i]}`
		return i === activeTabIndex ? `${TAB_ACTIVE}[${text}]${TAB_RESET}` : `${TAB_INACTIVE} ${text} ${TAB_RESET}`
	}).join('')
}

function renderBusyStatus(): void {
	setStatusLine(renderTabsForStatus(), [roleLabel, lastContextStatus ?? ''].filter(Boolean).join(' · '))
}
