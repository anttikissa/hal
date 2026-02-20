import { randomBytes } from "crypto"
import { basename, resolve } from "path"
import {
	appendCommand as appendBusCommand,
	readRecentEvents,
	readState,
	tailEvents,
} from "../ipc.ts"
import * as tui from "./tui.ts"
import {
	flashHeader,
	getOutputSnapshot,
	setActivityLine,
	setEscHandler,
	setInputEchoFilter,
	setInputKeyHandler,
	setMaxPromptLines,
	setOutputSnapshot,
	setStatusLine,
	setTabCompleter,
} from "./tui.ts"
import { makeCommand, type CommandType, type RuntimeCommand, type RuntimeEvent, type SessionInfo } from "../protocol.ts"
import { pushEvent, pushFragment, resetFormat, stripAnsi } from "./format.ts"
import {
	ALT_DIGIT_KEYS,
	CTRL_DIGIT_KEYS,
	CTRL_NEXT_TAB,
	CTRL_PREV_TAB,
	CTRL_T_KEYS,
	CTRL_W_KEYS,
} from "./keys.ts"
import { COMMAND_NAMES, handleCommand, isExit } from "./commands.ts"
import { LAUNCH_CWD } from "../state.ts"
import { loadConfig, MODEL_ALIASES } from "../config.ts"

export class Client {
	async command(type: CommandType, text?: string): Promise<void> {
		await appendCommand(type, text)
	}
	log(kind: string, text: string): void {
		pushLocal(kind, text)
	}
	async prompt(message: string, promptStr: string): Promise<string | null> {
		return tui.prompt(message, promptStr)
	}
	clear(): void {
		tui.clearOutput()
	}
	async closeTab(): Promise<void> {
		await closeActiveTab()
	}
}

const ALL_MODELS = [
	...Object.keys(MODEL_ALIASES),
	...Object.values(MODEL_ALIASES),
]

function normalizeCommandInput(input: string): string {
	return stripAnsi(input).replace(/[\u0000-\u001f\u007f]/g, "").trim().toLowerCase()
}

interface CliTab {
	sessionId: string
	workingDir: string
	name: string
	output: string
	contextStatus: string | null
	activity: string
	busy: boolean
}

function completeInput(prefix: string): string[] {
	if (prefix.startsWith("/") && !prefix.includes(" ")) {
		return COMMAND_NAMES.map(c => "/" + c).filter(c => c.startsWith(prefix))
	}
	if (prefix.startsWith("/model ")) {
		const partial = prefix.slice(7)
		return ALL_MODELS.filter(m => m.startsWith(partial)).map(m => `/model ${m}`)
	}
	return []
}

// TODO: session IDs in tab names take too much space — move to a /status command or tooltip
function sessionName(session: Pick<SessionInfo, "name" | "workingDir" | "id">): string {
	const explicit = typeof session.name === "string" ? session.name.trim() : ""
	if (explicit) return explicit
	const dirName = basename(session.workingDir || "")
	const shortId = session.id.replace(/^s-/, "").slice(0, 6)
	if (dirName) return `${dirName}:${shortId}`
	return session.id.slice(0, 8)
}

// Module state
let source: RuntimeCommand["source"]
let isOwner = false
let stopped = false
let lastContextStatus: string | null = null
let roleLabel = ""

const client = new Client()
let tabs: CliTab[] = []
let activeTabIndex = 0
let launchCwd = ""

export function init(src: RuntimeCommand["source"], owner: boolean): void {
	source = src
	isOwner = owner
	launchCwd = resolve(LAUNCH_CWD)
	setMaxPromptLines(loadConfig().maxPromptLines)
}

export async function start(): Promise<void> {
	tui.init()
	setTabCompleter(completeInput)
	setEscHandler(() => handleEsc())
	setInputKeyHandler((key) => handleInputKey(key))
	setInputEchoFilter((value) => !isExit(normalizeCommandInput(value)))
	roleLabel = isOwner ? "owner" : "client"

	pushLocal("local.info", `HAL connected (${roleLabel}). Type a message or /help.`)
	await bootstrapState()

	void (async () => {
		try {
			for await (const event of tailEvents()) {
				if (stopped) break
				render(event)
			}
		} catch (e: any) {
			if (!stopped) pushLocal("local.error", `[event-tail] ${e.message || e}`)
		}
	})()

	try {
		while (!stopped) {
			const input = await tui.input(" ")
			if (input === null) break
			const trimmed = input.trim()
			const normalized = normalizeCommandInput(input)
			if (!trimmed) continue
			if (isExit(normalized)) break
			await handleCommand(input, client)
		}
	} finally {
		setInputKeyHandler(null)
		setEscHandler(null)
		setInputEchoFilter(null)
		stopped = true
		try { tui.cleanup() } catch {}
	}
}

// Internal helpers

function activeTab(): CliTab | null {
	return tabs[activeTabIndex] ?? null
}

function pushLocal(kind: string, text: string): void {
	tui.write(pushFragment(kind, text))
}

function ensureFallbackTab(activeSessionId: string | null = null): void {
	if (tabs.length > 0) return
	const sessionId = activeSessionId || `s-${source.clientId.slice(0, 6)}`
	tabs = [{
		sessionId,
		workingDir: launchCwd,
		name: sessionName({ id: sessionId, name: undefined, workingDir: launchCwd }),
		output: "",
		contextStatus: null,
		activity: "",
		busy: false,
	}]
	activeTabIndex = 0
	applyActiveTabSnapshot(false)
}

function captureActiveOutput(): void {
	const active = activeTab()
	if (active) active.output = getOutputSnapshot()
}

function applyActiveTabSnapshot(clearWhenEmpty: boolean): void {
	const active = activeTab()
	if (!active) return
	resetFormat()
	lastContextStatus = active.contextStatus
	setActivityLine(active.busy ? active.activity || "Working..." : "")
	if (clearWhenEmpty) {
		// Full redraw: clear screen and rewrite content (tab switch / initial load)
		if (active.output.length > 0) tui.replaceOutput(active.output)
		else tui.clearOutput()
	} else {
		// Just update transcript, no visual change
		if (active.output.length > 0) setOutputSnapshot(active.output)
	}
	ensureTabBootstrap(active)
	renderBusyStatus()
}

function ensureTabBootstrap(tab: CliTab): void {
	if (!tab || tab.output.trim().length > 0) return
	appendBusCommand(makeCommand("cd", source, tab.workingDir, tab.sessionId)).catch(() => {})
}

function switchToTab(index: number): void {
	if (index < 0 || index >= tabs.length || index === activeTabIndex) return
	captureActiveOutput()
	activeTabIndex = index
	applyActiveTabSnapshot(true)
}

function handleInputKey(key: string): boolean {
	if (CTRL_T_KEYS.has(key)) { void createTab(); return true }
	if (CTRL_W_KEYS.has(key)) { void closeActiveTab(); return true }

	const digit = CTRL_DIGIT_KEYS[key] ?? ALT_DIGIT_KEYS[key]
	if (digit) { switchToTab(digit - 1); return true }
	if (CTRL_PREV_TAB.has(key)) { switchToTab(activeTabIndex > 0 ? activeTabIndex - 1 : tabs.length - 1); return true }
	if (CTRL_NEXT_TAB.has(key)) { switchToTab(activeTabIndex < tabs.length - 1 ? activeTabIndex + 1 : 0); return true }

	return false
}

function makeLocalSessionId(): string {
	let id = ""
	do { id = `s-${randomBytes(3).toString("hex")}` } while (tabs.some(t => t.sessionId === id))
	return id
}

async function createTab(): Promise<void> {
	if (tabs.length >= 9) { pushLocal("local.warn", "[tabs] max 9 tabs"); return }
	captureActiveOutput()
	const sessionId = makeLocalSessionId()
	tabs.push({
		sessionId,
		workingDir: launchCwd,
		name: sessionName({ id: sessionId, name: undefined, workingDir: launchCwd }),
		output: "",
		contextStatus: null,
		activity: "",
		busy: false,
	})
	activeTabIndex = tabs.length - 1
	applyActiveTabSnapshot(true)
	pushLocal("local.tab", `[tab] opened ${activeTabIndex + 1}: ${launchCwd}`)
	let hint = "[tabs] Switch: Alt-1..9 | Cycle: Ctrl-P/N | Close: Ctrl-W"
	if (process.platform === "darwin") {
		const term = process.env.TERM_PROGRAM ?? ""
		if (term === "iTerm.app") hint += " | iTerm2: set Preferences > Profiles > Keys > Option Key to 'Esc+'"
		else if (term === "Apple_Terminal") hint += " | Terminal.app: enable Preferences > Profiles > Keyboard > 'Use Option as Meta key'"
	}
	pushLocal("local.tabs", hint)
}

async function closeActiveTab(): Promise<void> {
	const active = activeTab()
	if (!active) return
	if (tabs.length <= 1) { pushLocal("local.warn", "[tabs] cannot close last tab (type exit to quit)"); return }
	await appendBusCommand(makeCommand("close", source, undefined, active.sessionId))
	pushLocal("local.queue", `close tab ${active.sessionId.slice(0, 8)}`)
}

function syncTabsFromSessions(
	sessions: SessionInfo[],
	preferredActiveSessionId: string | null,
	options: { preserveActiveOutput?: boolean; render?: boolean; bootstrap?: boolean } = {},
): void {
	if (!Array.isArray(sessions) || sessions.length === 0) return
	const preserveActiveOutput = options.preserveActiveOutput ?? true
	if (preserveActiveOutput) captureActiveOutput()

	const previousById = new Map(tabs.map(t => [t.sessionId, t]))
	const previousActive = activeTab()?.sessionId ?? null

	tabs = sessions.slice(0, 9).map(session => {
		const existing = previousById.get(session.id)
		return {
			sessionId: session.id,
			workingDir: session.workingDir,
			name: sessionName(session),
			output: preserveActiveOutput ? (existing?.output ?? "") : "",
			contextStatus: preserveActiveOutput ? (existing?.contextStatus ?? null) : null,
			activity: preserveActiveOutput ? (existing?.activity ?? "") : "",
			busy: preserveActiveOutput ? (existing?.busy ?? false) : false,
		}
	})

	const targetSessionId =
		(previousActive && tabs.some(t => t.sessionId === previousActive) ? previousActive : null) ??
		(preferredActiveSessionId && tabs.some(t => t.sessionId === preferredActiveSessionId) ? preferredActiveSessionId : null) ??
		tabs[0].sessionId

	const nextIndex = tabs.findIndex(t => t.sessionId === targetSessionId)
	activeTabIndex = nextIndex >= 0 ? nextIndex : 0
	if (options.render ?? true) applyActiveTabSnapshot(false)
	if (options.bootstrap ?? true) for (const tab of tabs) ensureTabBootstrap(tab)
}

function hydrateTabsFromRecentLines(events: RuntimeEvent[], maxLinesPerTab = 120): void {
	const bySession = new Map<string, string[]>()
	for (const event of events) {
		if (!("sessionId" in event)) continue
		const sessionId = event.sessionId
		if (!sessionId) continue
		const tab = findTabBySessionId(sessionId)
		if (!tab) continue

		if (event.type === "line" && event.level === "status") {
			updateTabStatusMetadata(tab, event.text)
			continue
		}

		const formatted = pushEvent(event, source)
		if (!formatted) continue
		const lines = bySession.get(sessionId) ?? []
		lines.push(formatted)
		if (lines.length > maxLinesPerTab) lines.splice(0, lines.length - maxLinesPerTab)
		bySession.set(sessionId, lines)
	}

	for (const tab of tabs) {
		if (tab.output.trim().length > 0) continue
		const lines = bySession.get(tab.sessionId)
		if (lines?.length) tab.output = lines.join("")
	}
}

function findTabBySessionId(sessionId: string): CliTab | null {
	return tabs.find(t => t.sessionId === sessionId) ?? null
}

function findOrCreateTabBySessionId(sessionId: string): CliTab | null {
	const existing = findTabBySessionId(sessionId)
	if (existing) return existing
	if (tabs.length >= 9) return null
	const tab: CliTab = {
		sessionId,
		workingDir: launchCwd,
		name: sessionName({ id: sessionId, name: undefined, workingDir: launchCwd }),
		output: "",
		contextStatus: null,
		activity: "",
		busy: false,
	}
	tabs.push(tab)
	renderBusyStatus()
	return tab
}

function handleEsc(): void {
	const active = activeTab()
	if (!active || !active.busy) return
	appendBusCommand(makeCommand("pause", source, undefined, active.sessionId)).catch(() => {})
	flashHeader("\x1b[33mpausing...\x1b[0m")
	setActivityLine("Paused")
}

async function bootstrapState(): Promise<void> {
	try {
		const state = await readState()
		const busySet = new Set(state.busySessionIds ?? [])

		if (Array.isArray(state.sessions) && state.sessions.length > 0) {
			syncTabsFromSessions(state.sessions, state.activeSessionId ?? null, {
				preserveActiveOutput: false, render: false, bootstrap: false,
			})
		} else {
			ensureFallbackTab(state.activeSessionId ?? null)
		}
		for (const tab of tabs) tab.busy = busySet.has(tab.sessionId)

		const recent = await readRecentEvents(500)
		hydrateTabsFromRecentLines(recent)
		for (const event of recent) {
			if (event.type !== "line" || event.level !== "status") continue
			const sessionId = event.sessionId ?? activeTab()?.sessionId ?? null
			if (!sessionId) continue
			const tab = findTabBySessionId(sessionId)
			if (tab) updateTabStatusMetadata(tab, event.text)
		}

		applyActiveTabSnapshot(true)
		for (const tab of tabs) ensureTabBootstrap(tab)
		renderBusyStatus()
	} catch (e: any) {
		pushLocal("local.status", `bootstrap failed: ${e.message || e}`)
		ensureFallbackTab(null)
		renderBusyStatus()
	}
}

function activeSessionId(): string | null {
	return activeTab()?.sessionId ?? null
}

async function appendCommand(type: RuntimeCommand["type"], text?: string): Promise<void> {
	await appendBusCommand(makeCommand(type, source, text, activeSessionId()))
}

function updateTabStatusMetadata(tab: CliTab, line: string): void {
	const stripped = stripAnsi(line).trim()
	if (stripped.startsWith("[context]")) tab.contextStatus = line
}

function renderEventToTab(tab: CliTab, event: RuntimeEvent, renderToScreen: boolean): void {
	if (event.type === "line" && event.level === "status") {
		updateTabStatusMetadata(tab, event.text)
		if (renderToScreen && tab === activeTab()) lastContextStatus = tab.contextStatus
	}

	const text = pushEvent(event, source)
	if (!text) return
	if (renderToScreen) tui.write(text)
	else tab.output += text
}

function render(event: RuntimeEvent): void {
	if (event.type === "sessions") {
		syncTabsFromSessions(event.sessions, event.activeSessionId ?? null)
		return
	}

	if (event.type === "status") {
		const isActivityOnly = "activity" in event && event.activity !== undefined

		if (isActivityOnly) {
			// Activity-only update — route activity to the correct tab and infer busy state
			const tab = event.sessionId ? findTabBySessionId(event.sessionId) : null
			if (tab) {
				tab.activity = event.activity!
				tab.busy = event.activity !== ""
			}
		} else {
			// Full status update — sync per-tab busy state from busySessionIds
			const busySet = new Set(event.busySessionIds ?? [])
			for (const tab of tabs) {
				const wasBusy = tab.busy
				tab.busy = busySet.has(tab.sessionId)
				if (!tab.busy && wasBusy) tab.activity = ""
			}
		}

		// Only update the displayed activity line based on the active tab
		const active = activeTab()
		if (active) {
			setActivityLine(active.busy ? active.activity || "Working..." : "")
		}

		renderBusyStatus()
		return
	}

	const sessionId = "sessionId" in event ? event.sessionId : null
	if (!sessionId) {
		const active = activeTab()
		if (active) renderEventToTab(active, event, true)
		return
	}

	const tab =
		event.type === "line" || event.type === "chunk" || event.type === "prompt"
			? findOrCreateTabBySessionId(sessionId)
			: findTabBySessionId(sessionId)
	if (!tab) return

	if (tab === activeTab()) {
		renderEventToTab(tab, event, true)
		renderBusyStatus()
		return
	}

	renderEventToTab(tab, event, false)
}

/** Build tab portion for the status line: [1:tab] 2:tab  3:tab */
function renderTabsForStatus(): string {
	if (tabs.length === 0) return ""
	return tabs.slice(0, 9).map((tab, i) => {
		const label = `${i + 1}:${tab.name}`
		return i === activeTabIndex ? `[${label}]` : ` ${label} `
	}).join("")
}

function renderBusyStatus(): void {
	const tabStr = renderTabsForStatus()
	const contextOnly = lastContextStatus?.replace(/^\[context\]\s*/, "") ?? ""
	const parts = [roleLabel, contextOnly].filter(Boolean)
	setStatusLine(tabStr, parts.join("  "))
}
