// Slash commands — parsed from user input starting with '/'.
//
// Commands are processed BEFORE sending to the agent loop. If a command
// is recognized, it's handled directly and the prompt is not forwarded
// to the model.

import { appendFileSync, existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { ipc } from '../file-ipc.ts'
import { models } from '../../common/models.ts'
import { commandMetadata, type CommandArg } from '../../common/command-metadata.ts'
import { serverModels } from '../models.ts'
import { ason } from '../../utils/ason.ts'
import { config } from '../../config.ts'
import { context } from './system-prompt.ts'
import { sessions as sessionStore } from '../sessions.ts'
import { inbox } from './inbox.ts'
import { agentLoop } from './agent-loop.ts'
import { anthropicUsage } from '../anthropic-usage.ts'
import { openaiUsage } from '../openai-usage.ts'
import { memory } from '../memory.ts'
import { version } from '../version.ts'
import { time } from '../../utils/time.ts'
import { visLen } from '../../utils/strings.ts'
import { HAL_DIR } from '../state.ts'
import { authLogin } from '../auth-login.ts'
import { isPidAlive } from '../../utils/is-pid-alive.ts'
import type { SharedClientInfo } from '../../common/ipc.ts'
import type { QuestionInput, QuestionSource } from '../../common/history.ts'
import { serverKeys } from '../server-keys.ts'
import { modelRefresh } from '../model-refresh.ts'
import { paths } from '../paths.ts'

// ── Types ──

export interface CommandResult {
	/** Text output to show the user (info level). */
	output?: string
	/** Error message to show the user. */
	error?: string
	/** Optional presentation for special informational output. */
	ui?: 'notice'
	/** Permit only /status's generated ANSI progress bars to reach the renderer. */
	usageBars?: true
	/** Render output as a persisted synthetic assistant message. */
	syntheticKind?: string
	/** Durable question appended after command output. */
	question?: CommandQuestion
	/** Whether the command was recognized and handled. */
	handled: boolean
}


export type CommandQuestion = { text: string; input: QuestionInput; source: QuestionSource }

export interface CommandHooks {
	/** Emit a user-visible progress/info notice while a command is still running. */
	info?: (text: string, level?: 'info' | 'error') => void
}

let state = {
	scheduleExit(code: number, delayMs: number): void {
		setTimeout(() => process.exit(code), delayMs)
	},
	web: async (_args: string): Promise<{ output?: string; error?: string }> => ({ error: 'Web server is unavailable.' }),
}

/** Session state that commands can read and modify. */
export interface SessionRef {
	id: string
	name: string
}

export interface SessionState {
	id: string
	name: string
	model?: string
	cwd: string
	createdAt: string
	sessions?: SessionRef[]
}

// ── Command parsing ──

interface ParsedCommand {
	name: string
	args: string
}

/** Parse a /command from user input. Returns null if not a command. */
function parseCommand(text: string): ParsedCommand | null {
	const trimmed = text.trim()
	if (!trimmed.startsWith('/')) return null

	// Split on first whitespace: /command args...
	const spaceIdx = trimmed.indexOf(' ')
	if (spaceIdx === -1) {
		return { name: trimmed.slice(1), args: '' }
	}
	return {
		name: trimmed.slice(1, spaceIdx),
		args: trimmed.slice(spaceIdx + 1).trim(),
	}
}

// ── Command handlers ──
// Each handler returns a CommandResult. The runtime dispatches based on name.

type CommandHandler = (
	args: string,
	session: SessionState,
	hooks: CommandHooks,
) => CommandResult | Promise<CommandResult>


const handlers: Record<string, CommandHandler> = {}
const workingSafeCommands = new Set([
	'broadcast',
	'clients',
	'check',
	'fork',
	'help',
	'history',
	'mem',
	'move',
	'open',
	'rename',
	'resume',
	'self',
	'pause',
	'send',
	'status',
	'system',
	'tabs',
	'todo',
	'web',
])

function normalizeSessionName(text: string): string {
	return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

function resolveTabTarget(session: SessionState, raw: string): SessionRef | null {
	const sessions = session.sessions ?? []
	if (/^\d+$/.test(raw)) {
		const index = parseInt(raw, 10) - 1
		return sessions[index] ?? null
	}
	const exactId = sessions.find((item) => item.id === raw)
	if (exactId) return exactId
	const normalized = normalizeSessionName(raw)
	return sessions.find((item) => normalizeSessionName(item.name) === normalized) ?? null
}

function resolveSendTarget(session: SessionState, args: string): { target: SessionRef; text: string } | null {
	const trimmed = args.trim()
	if (!trimmed) return null
	const sessions = session.sessions ?? []
	const firstSpace = trimmed.indexOf(' ')
	const firstToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)
	const firstTarget = resolveTabTarget(session, firstToken)
	if (firstTarget && firstSpace !== -1) {
		const text = trimmed.slice(firstSpace + 1).trim()
		return text ? { target: firstTarget, text } : null
	}
	const matches = sessions
		.filter((item) => item.id !== session.id)
		.map((item) => ({ item, normalized: normalizeSessionName(item.name) }))
		.filter(({ normalized }) => trimmed === normalized || trimmed.startsWith(`${normalized} `))
		.sort((a, b) => b.normalized.length - a.normalized.length)
	const match = matches[0]
	if (!match) return null
	const text = trimmed.slice(match.normalized.length).trim()
	return text ? { target: match.item, text } : null
}

function currentTabIndex(session: SessionState): number {
	const sessions = session.sessions ?? []
	return sessions.findIndex((item) => item.id === session.id)
}

function clampMovePosition(session: SessionState, raw: string): { capped: number; max: number } | null {
	if (!/^-?\d+$/.test(raw)) return null
	const sessions = session.sessions ?? []
	const max = Math.max(1, sessions.length)
	const requested = parseInt(raw, 10)
	const capped = Math.max(1, Math.min(max, requested))
	return { capped, max }
}

function sendToSession(from: SessionState, target: SessionRef, text: string): CommandResult {
	if (target.id === from.id) {
		return { error: 'Cannot send to the current session.', handled: true }
	}
	inbox.queueMessage(target.id, text, from.id)
	return { output: `Message sent to ${target.name} · ${target.id}`, handled: true }
}

function closedSessionLines(): string[] {
	const openIds = new Set(sessionStore.loadSessionList())
	const closed = sessionStore
		.loadAllSessionMetas()
		.filter((meta) => !openIds.has(meta.id))
		.sort((a, b) => (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt))
	if (closed.length === 0) return ['No closed sessions.']
	const rows = closed.slice(0, 20).map((meta) => ({
		label: meta.name && meta.name !== meta.id ? `${meta.id}  ${meta.name}` : meta.id,
		closedAt: meta.closedAt && time.formatLocalDateTime(meta.closedAt),
	}))
	const width = Math.max(...rows.map((row) => visLen(row.label)))
	return ['Closed sessions:', ...rows.map((row) => `  ${padVisible(row.label, width)}${row.closedAt ? `  · closed ${row.closedAt}` : ''}`)]
}

interface ResumeLookup {
	id?: string
	error?: string
}

function lookupClosedResumeTarget(selector: string): ResumeLookup {
	const trimmed = selector.trim()
	if (!trimmed) return {}
	const openIds = new Set(sessionStore.loadSessionList())
	const metas = sessionStore.loadAllSessionMetas()
	const exactId = metas.find((meta) => meta.id === trimmed)
	if (exactId) {
		if (openIds.has(exactId.id)) return { error: `Session ${exactId.id} is already open.` }
		return { id: exactId.id }
	}
	const normalized = normalizeSessionName(trimmed)
	const exactName = metas.find((meta) => !openIds.has(meta.id) && normalizeSessionName(meta.name ?? '') === normalized)
	if (exactName) return { id: exactName.id }
	return { error: 'No matching closed session.' }
}

function sessionDisplayName(meta: any, fallbackName: string): string {
	return meta?.name || fallbackName
}

function closedTabs(showAll: boolean, openIds: Set<string>): any[] {
	if (!showAll) return []
	return sessionStore
		.loadAllSessionMetas()
		.filter((meta) => !openIds.has(meta.id))
		.sort((a, b) => (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt))
}

function formatStamp(isoTs: string): string {
	return isoTs.replace('T', ' ').slice(0, 16)
}

function currentHalDir(): string {
	// Tests and embedded runtimes can override HAL_DIR after this module has been
	// imported, so read the environment at call time and use the imported path only
	// as the normal startup-time fallback.
	return process.env.HAL_DIR ?? HAL_DIR
}

function renderTabs(args: string, session: SessionState): CommandResult {
	const trimmed = args.trim()
	if (trimmed && trimmed !== '--all') return { error: 'Usage: /tabs [--all]', handled: true }
	const showAll = trimmed === '--all'
	const openTabs = session.sessions ?? []
	const openIds = new Set(openTabs.map((tab) => tab.id))
	const metaById = new Map(sessionStore.loadAllSessionMetas().map((meta) => [meta.id, meta]))
	const rows = [
		...openTabs.map((tab, index) => {
			const meta = metaById.get(tab.id)
			return {
				id: tab.id,
				where: `tab ${index + 1}`,
				name: sessionDisplayName(meta, tab.name || tab.id),
				createdAt: meta?.createdAt ?? session.createdAt,
				closedAt: meta?.closedAt,
			}
		}),
		...closedTabs(showAll, openIds).map((meta) => ({
			id: meta.id,
			where: 'closed',
			name: sessionDisplayName(meta, meta.id),
			createdAt: meta.createdAt,
			closedAt: meta.closedAt,
		})),
	]
	if (rows.length === 0) return { output: showAll ? 'No sessions.' : 'No open tabs.', handled: true }
	const lines = [showAll ? 'Sessions:' : 'Open tabs:']
	for (const row of rows) {
		const marker = row.id === session.id ? '*' : ' '
		lines.push(`${marker} ${row.where.padEnd(7)} ${row.id}  ${row.name}`)
		const dates = [`start ${formatStamp(row.createdAt)}`]
		if (row.closedAt) dates.push(`end ${formatStamp(row.closedAt)}`)
		lines.push(`          ${dates.join(' · ')}`)
	}
	return { output: lines.join('\n'), handled: true }
}

function renderRuntimeStatus(): string {
	const host = ipc.readState().host
	const lines = [
		'Runtime:',
		`Role: ${ipc.ownsHostLock() ? 'server' : 'client'}`,
		`PID: ${process.pid}`,
		`Version: ${version.state.status === 'ready' ? version.state.combined : version.state.status === 'error' ? `error: ${version.state.error}` : 'checking...'}`,
	]
	if (host?.pid) lines.push(`Host: ${host.pid}${host.startedAt ? ` (${host.startedAt})` : ''}`)
	return lines.join('\n')
}

function processVersionLabel(status: string, value?: string, error?: string): string {
	if (status === 'ready') return value || 'unknown'
	if (status === 'error') return `error: ${error || 'unknown'}`
	return status || 'unknown'
}

function connectedClients(clients: SharedClientInfo[]): SharedClientInfo[] {
	return clients.filter((item) => item.pid > 0 && isPidAlive(item.pid))
}

function renderClientsStatus(): string {
	const shared = ipc.readState()
	const host = shared.host
	const lines = ['Processes:', 'Server:']
	if (host?.pid) {
		lines.push(`  pid ${host.pid}  version ${processVersionLabel(host.versionStatus, host.version, host.error)}`)
		if (host.startedAt) lines.push(`       started ${formatStamp(host.startedAt)}`)
	} else {
		lines.push('  none')
	}

	lines.push('Clients:')
	const clients = connectedClients(shared.clients ?? []).sort((a, b) => a.pid - b.pid)
	if (clients.length === 0) {
		lines.push('  none')
		return lines.join('\n')
	}

	for (const item of clients) {
		const session = item.sessionId ? `  session ${item.sessionId}` : ''
		lines.push(`  pid ${item.pid}${session}  version ${processVersionLabel(item.versionStatus, item.version, item.error)}`)
		const dates = [`seen ${formatStamp(item.updatedAt)}`]
		if (item.startedAt) dates.push(`started ${formatStamp(item.startedAt)}`)
		if (item.cwd) dates.push(item.cwd)
		lines.push(`       ${dates.join(' · ')}`)
	}
	return lines.join('\n')
}


function padVisible(text: string, width: number): string {
	return text + ' '.repeat(Math.max(0, width - visLen(text)))
}


// /help — list commands or show details for one command
handlers['help'] = (args) => {
	const commandName = commandMetadata.normalizeHelpCommand(args)
	if (commandName) {
		const text = commandMetadata.detailedHelp(commandName)
		if (!text) return { error: `No detailed help for /${commandName}. Try /help.`, handled: true }
		return { output: text, handled: true }
	}
	return { output: commandMetadata.commandListHelp(), handled: true }
}

// /model [name] — switch model or show current + list
handlers['model'] = (args, session) => {
	if (!args) {
		const current = session.model ?? models.defaultModel()
		const display = models.displayModel(current)
		const lines = [`Current: ${display} (${current})`, '', ...models.listModels()]
		return { output: lines.join('\n'), handled: true }
	}

	const oldModel = models.resolveModel(session.model ?? models.defaultModel())
	// No validation: arbitrary provider/model IDs pass through so new models work before /check refreshes metadata
	const newModel = models.resolveModel(args)
	// Always store the canonical id: a session may hold a stale bare alias (e.g. "opus"),
	// which the provider loader cannot route. Only the notice is suppressed for a no-op.
	session.model = newModel
	if (newModel === oldModel) return { handled: true }
	const oldDisplay = models.displayModel(oldModel)
	const newDisplay = models.displayModel(newModel)
	return {
		output: `Model changed from ${oldDisplay} (${oldModel}) to ${newDisplay} (${newModel})`,
		ui: 'notice',
		handled: true,
	}
}

// /clear — rotate to a fresh log and reset replay context
handlers['clear'] = (_args, session) => {
	ipc.appendCommand({
		type: 'reset',
		sessionId: session.id,
	})
	return { handled: true }
}

// /history — show the active log, which may rotate after /clear or a rebase.
handlers['history'] = (_args, session) => {
	const logName = sessionStore.loadSessionMeta(session.id)?.currentLog
	return { output: `History: ${paths.historyDisplayPath(session.id, logName)}`, handled: true }
}

handlers['pause'] = (_args, session) => {
	ipc.appendCommand({ type: 'pause-before-tools', sessionId: session.id })
	return { handled: true }
}

// /fork — fork current session to new tab
handlers['fork'] = (_args, session) => {
	// Session forking requires disk operations (Plan 3). Signal intent via IPC.
	ipc.appendCommand({
		type: 'open',
		forkSessionId: session.id,
		sessionId: session.id,
	})
	return { handled: true }
}

// Commit the appended TODO line. The item is typed by the user, not written by
// a model, so the footer says who filed it rather than which model generated it.
// The pathspec form of `git commit` ignores whatever else a sibling session has
// staged. Any git failure (no repo, TODO.md ignored, nothing to commit) is
// silent: recording a TODO must never depend on git state.
function commitTodo(cwd: string, todoPath: string, item: string, sessionId: string): void {
	const message = `TODO: ${item}\n\nFiled via /todo (session ${sessionId})\n`
	Bun.spawnSync(['git', 'commit', '-m', message, '--', todoPath], { cwd, stdout: 'ignore', stderr: 'ignore' })
}

// /todo — record a project TODO. A TODO.md in the session cwd is the source of
// truth when it exists; otherwise Hal is asked to file the item wherever the
// project keeps them. Asking a busy session would interrupt its turn, so a
// working session gets a forked tab that carries the same context.
handlers['todo'] = (args, session) => {
	const item = args.trim()
	if (!item) return { error: 'Usage: /todo <item>', handled: true }

	const todoPath = resolve(session.cwd, 'TODO.md')
	if (existsSync(todoPath)) {
		const current = readFileSync(todoPath, 'utf8')
		const separator = !current || current.endsWith('\n') ? '' : '\n'
		appendFileSync(todoPath, `${separator}- ${item}\n`)
		commitTodo(session.cwd, todoPath, item, session.id)
		return { output: `Added to ${todoPath}`, handled: true }
	}

	const task = `Add a TODO item to this project: ${item}`
	if (agentLoop.isWorking(session.id)) {
		ipc.appendCommand({
			type: 'spawn',
			sessionId: session.id,
			spawn: { task, kind: 'interactive', mode: 'fork', cwd: session.cwd },
		})
		return { output: 'Session is working; forking a tab to add the TODO...', handled: true }
	}
	ipc.appendCommand({ type: 'prompt', sessionId: session.id, text: task })
	return { handled: true }
}

// /self — open a session rooted at Hal's own source/config directory
handlers['self'] = (args, session) => {
	const fork = args === '--fork' || args === '-f'
	if (args.trim() && !fork) return { error: 'Usage: /self [--fork|-f]', handled: true }
	const cwd = currentHalDir()
	if (fork) {
		ipc.appendCommand({ type: 'open', cwd, forkSessionId: session.id, sessionId: session.id })
		return { output: `Forking this conversation into Hal self session in ${cwd}...`, handled: true }
	}
	ipc.appendCommand({ type: 'open', cwd, forceNew: true, sessionId: session.id })
	return { output: `Opening Hal self session in ${cwd}...`, handled: true }
}

// /open [tab|session-id|name] — open a new tab, optionally after an existing tab
handlers['open'] = (args, session) => {
	const targetText = args.trim()
	if (!targetText) {
		ipc.appendCommand({ type: 'open', sessionId: session.id })
		return { output: 'Opening new tab...', handled: true }
	}

	const target = resolveTabTarget(session, targetText)
	if (!target) return { error: `Unknown tab, session, or name: ${targetText}`, handled: true }
	ipc.appendCommand({ type: 'open', afterSessionId: target.id, sessionId: session.id })
	return { output: `Opening new tab after ${target.name} (${target.id})...`, handled: true }
}


// /tabs [--all] — list tabs/sessions by most recent activity
handlers['tabs'] = (args, session) => {
	return renderTabs(args, session)
}

// /rename <name>|clear — set or clear the current session name
handlers['rename'] = (args, session) => {
	const raw = args.trim().replace(/\s+/g, ' ')
	if (!raw) {
		return { output: session.name ? `Current name: ${session.name}` : `Current name: ${session.id} (session id fallback)`, handled: true }
	}
	if (raw === 'clear' || raw === '-') {
		session.name = ''
		return { output: `Cleared session name; using ${session.id}`, handled: true }
	}
	if (!/^[A-Za-z0-9._ -]+$/.test(raw)) {
		return { error: 'Name may contain letters, digits, spaces, dot, dash, and underscore only.', handled: true }
	}
	session.name = raw
	return { output: `Renamed session to ${raw}`, handled: true }
}

// /move <position> — move the current tab to a 1-based position
handlers['move'] = (args, session) => {
	const parsed = clampMovePosition(session, args.trim())
	if (!parsed) return { error: 'Usage: /move <position>', handled: true }

	const currentIndex = currentTabIndex(session)
	const currentPos = currentIndex >= 0 ? currentIndex + 1 : 1
	if (parsed.capped === currentPos) {
		return { output: `Tab already at ${currentPos}.`, handled: true }
	}

	ipc.appendCommand({ type: 'move', position: parsed.capped, sessionId: session.id })
	return { output: `Moving tab to ${parsed.capped}/${parsed.max}...`, handled: true }
}

// /compact — summarize conversation
handlers['compact'] = (_args, session) => {
	ipc.appendCommand({
		type: 'compact',
		sessionId: session.id,
	})
	return { output: 'Compacting conversation...', handled: true }
}

// /rebase is handled by the interactive client so the editor runs on the user's terminal.
handlers['rebase'] = async () => {
	return { error: 'Run /rebase from an interactive client terminal.', handled: true }
}

handlers['clients'] = () => {
	return { output: renderClientsStatus(), handled: true }
}

// /check — manually run the same models.dev refresh used on startup.
handlers['check'] = async (args, session, hooks) => {
	if (args.trim()) return { error: 'Usage: /check', handled: true }
	hooks.info?.('Checking models.dev for model updates...')
	try {
		const checked = await modelRefresh.checkModels()
		const lines = [checked.message]
		if (checked.result.hadCache) {
			const updates = models.aliasUpdateSuggestions(checked.result.previous, checked.result.next)
			const discoveries = models.modelDiscoveries(checked.result.previous, checked.result.next).filter((item) => serverModels.hasConfiguredDirectSource(item.model))
			if (updates.length || discoveries.length) lines.push('', modelRefresh.buildNewModelDiscoveryText(discoveries, updates))
		}
		return { output: lines.join('\n'), handled: true }
	} catch (err: any) {
		return { error: `/check: ${err?.message ?? String(err)}`, handled: true }
	}
}

// /status — runtime version + Anthropic / OpenAI OAuth subscription usage
handlers['status'] = async (_args, _session, hooks) => {
	let anthropicText = ''
	let openaiText = ''
	const pending: Promise<void>[] = []

	// Fetch both services concurrently, but emit the notices in a stable order so
	// the user immediately sees what slow network calls /status is waiting on.
	if (anthropicUsage.hasCredentials()) {
		hooks.info?.('Fetching subscription usage from Anthropic...')
		pending.push(anthropicUsage.renderStatus(true).then((text) => { anthropicText = text }))
	}
	if (openaiUsage.hasCredentials()) {
		hooks.info?.('Fetching subscription usage from OpenAI...')
		pending.push(openaiUsage.renderStatus(true).then((text) => { openaiText = text }))
	}

	await Promise.all(pending)
	const sections = [anthropicText, openaiText].filter((text) => text && !/^No (Anthropic Claude|OpenAI ChatGPT) subscriptions configured\.$/.test(text.trim()))
	const hasAnthropic = anthropicUsage.hasCredentials()
	const hasOpenai = openaiUsage.hasCredentials()
	let usage = sections.length > 0 ? sections.join('\n\n') : 'No OAuth subscription credentials configured.'
	const hints: string[] = []
	if (!hasAnthropic) hints.push('  /login claude    — log in to Claude')
	if (!hasOpenai) hints.push('  /login chatgpt   — log in to ChatGPT')
	if (hints.length > 0) {
		usage += `\n\nAdd a subscription:\n${hints.join('\n')}`
	}
	return {
		output: `${renderRuntimeStatus()}\n\n${usage}`,
		usageBars: true,
		handled: true,
	}
}

// /login <provider> — Claude returns its code through a durable secret question;
// ChatGPT uses OpenAI's device-code flow, which works on remote and headless hosts.
// Users subscribe to Claude and ChatGPT, not to "Anthropic" and "OpenAI", so the
// product names are what we ask for. The company names stay as hidden aliases:
// they name the provider prefixes in model IDs and the API key env vars, so
// people will reasonably try them.
handlers['login'] = async (args, _session, hooks) => {
	const parts = args.trim().split(/\s+/).filter(Boolean)
	const provider = parts[0]
	const codeArg = parts.slice(1).join(' ')

	if (provider === 'claude' || provider === 'anthropic') {
		if (codeArg) return { error: 'Usage: /login claude', handled: true }
		const { url } = await authLogin.startAnthropic()
		return {
			output: ['Open this URL to log in to Claude:', '', url].join('\n'),
			question: {
				text: 'Paste the code#state value from the Claude redirect page.',
				input: { kind: 'secret', publicKey: serverKeys.publicKey(), maxBytes: 190 },
				source: { type: 'login', provider: 'claude' },
			},
			handled: true,
		}
	}

	if (provider === 'chatgpt' || provider === 'openai') {
		hooks.info?.('Starting ChatGPT device-code login (15min timeout)...')
		try {
			await authLogin.loginOpenai((msg) => hooks.info?.(msg))
			return { output: 'Logged in to ChatGPT. Run /status to see usage.', handled: true }
		} catch (err: any) {
			return { error: `Login failed: ${err?.message ?? err}`, handled: true }
		}
	}

	return { error: 'Usage: /login <claude|chatgpt>', handled: true }
}


// /mem — current RSS + memory thresholds
handlers['mem'] = () => {
	function threshold(bytes: number): string {
		return bytes > 0 ? memory.formatMemory(bytes) : 'disabled'
	}

	const rss = memory.io.readRss()
	const lines = [
		'Memory:',
		`Current: ${memory.formatMemory(rss)}`,
		`Warn: ${threshold(memory.config.warnBytes)}`,
		`Kill: ${threshold(memory.config.killBytes)}`,
	]
	return { output: lines.join('\n'), handled: true }
}

// /resume [id|name] — list closed sessions or reopen one as a tab
handlers['resume'] = (args, session) => {
	const selector = args.trim()
	if (!selector) return { output: closedSessionLines().join('\n'), handled: true }
	const target = lookupClosedResumeTarget(selector)
	if (target.error) return { error: target.error, handled: true }
	ipc.appendCommand({ type: 'resume', selector, sessionId: session.id })
	return { output: `Resuming ${target.id}...`, handled: true }
}

// /send <tab|session-id|name> <message> — queue a message for another session
handlers['send'] = (args, session, hooks) => {
	const trimmed = args.trim()
	if (trimmed === 'all' || trimmed.startsWith('all ')) return handlers['broadcast']!(trimmed.slice(3).trim(), session, hooks)
	const parsed = resolveSendTarget(session, args)
	if (!parsed) return { error: 'Usage: /send <tab|session-id|name> <message>', handled: true }
	return sendToSession(session, parsed.target, parsed.text)
}

// /broadcast <message> — queue the same message for every other session
handlers['broadcast'] = (args, session) => {
	const text = args.trim()
	if (!text) return { error: 'Usage: /broadcast <message>', handled: true }
	const targets = (session.sessions ?? []).filter((item) => item.id !== session.id)
	if (targets.length === 0) return { error: 'No other sessions.', handled: true }
	for (const target of targets) inbox.queueMessage(target.id, text, session.id)
	return { output: `Broadcast to ${targets.length} sessions`, handled: true }
}

function parseCdPathArg(args: string): { path?: string; error?: string } {
	const text = args.trim()
	if (!text) return { path: HAL_DIR }
	let out = ''
	let quote = ''
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!
		if (ch === '\\') {
			if (i + 1 < text.length) out += text[++i]!
			else out += ch
			continue
		}
		if (quote) {
			if (ch === quote) quote = ''
			else out += ch
			continue
		}
		if (ch === '"' || ch === "'") {
			quote = ch
			continue
		}
		out += ch
	}
	if (quote) return { error: 'missing closing quote' }
	return { path: out.replace(/^~(?=$|\/)/, homedir()) }
}

// /cd [path] — change working directory. With no path, jump to Hal's own
// directory as a quick recovery when a self-edit prompt was typed elsewhere.
handlers['cd'] = (args, session) => {
	const parsed = parseCdPathArg(args)
	if (parsed.error) return { error: `cd failed: ${parsed.error}`, handled: true }
	const target = resolve(session.cwd, parsed.path!)

	if (!existsSync(target)) {
		return {
			output: `/cd: ${target} not found. Would you like to create that directory and then /cd into it?`,
			syntheticKind: 'cd-create-suggestion',
			handled: true,
		}
	}

	const old = session.cwd
	session.cwd = target

	// Report loaded agent files in the new directory
	const agents = context.collectAgentFiles(target)
	const parts = [`cwd: ${old} -> ${target}`]
	if (agents.length > 0) {
		const files = agents.map((f) => `${f.name} (${context.formatBytes(f.bytes)})`)
		parts.push(`Loaded ${files.join(', ')}`)
	}
	return {
		output: parts.join('\n'),
		handled: true,
	}
}

// /system — print the full preprocessed system prompt (SYSTEM.md + AGENTS.md chain)
handlers['system'] = (_args, session) => {
	const model = session.model ?? models.defaultModel()
	const result = context.buildSystemPrompt({ model, cwd: session.cwd, sessionId: session.id })
	const header = result.loaded.map((f) => `  ${f.name} (${context.formatBytes(f.bytes)}) — ${f.path}`).join('\n')
	return {
		output: `${header}\n  Total: ${context.formatBytes(result.bytes)}\n\n${result.text}`,
		handled: true,
	}
}


function parseConfigArgs(args: string): { help: boolean; temp: boolean; path: string; value: string } {
	const tokens = args.trim() ? args.trim().split(/\s+/) : []
	let help = false
	let temp = false
	const rest: string[] = []
	for (const token of tokens) {
		if (token === '--help') {
			help = true
			continue
		}
		if (token === '--temp') {
			temp = true
			continue
		}
		rest.push(token)
	}
	return {
		help,
		temp,
		path: rest[0] ?? '',
		value: rest.slice(1).join(' '),
	}
}

function writeConfigValue(path: string, rawValue: string, temp = false): { output?: string; error?: string } {
	const value = config.parseValue(path, rawValue)
	return config.writePath(path, value, { temp })
}

// /config — inspect or change runtime config
handlers['config'] = (args) => {
	const parsed = parseConfigArgs(args)
	if (parsed.help) return { output: commandMetadata.detailedHelp('config')!, handled: true }
	if (!parsed.path) return { output: `Current config:\n${ason.stringify(config.snapshot(), 'long')}`, handled: true }
	if (!parsed.value) {
		const read = config.readPath(parsed.path)
		if (read.error) return { error: read.error, handled: true }
		return { output: `${parsed.path}:\n${ason.stringify(read.value, 'long')}`, handled: true }
	}
	try {
		const write = writeConfigValue(parsed.path, parsed.value, parsed.temp)
		if (write.error) return { error: write.error, handled: true }
		return { output: write.output, handled: true }
	} catch (err: any) {
		return { error: `/config: could not parse value: ${err?.message ?? String(err)}`, handled: true }
	}
}


// /web — show, create, or revoke browser access tokens
handlers['web'] = async (args) => ({ ...await state.web(args), handled: true })



// /quit — quit
function quitCommand(): CommandResult {
	// Give cleanup and IPC tails a brief moment to flush before exiting.
	state.scheduleExit(0, 100)
	return { output: 'Goodbye.', handled: true }
}

handlers['quit'] = quitCommand
handlers['exit'] = quitCommand


// ── Main dispatch ──
function canRunWhileWorking(text: string): boolean {
	const parsed = parseCommand(text)
	return !!parsed && workingSafeCommands.has(parsed.name)
}

/** Execute a slash command. Returns { handled: false } if not a command. */
async function executeCommand(text: string, session: SessionState, hooks: CommandHooks = {}): Promise<CommandResult> {
	const parsed = parseCommand(text)
	if (!parsed) return { handled: false }

	const handler = handlers[parsed.name]
	if (!handler) {
		return { error: `Unknown command: /${parsed.name}. Type /help for help.`, handled: true }
	}

	return await handler(parsed.args, session, hooks)
}

/** Get list of command names for tab completion and /help. */
function commandNames(): string[] {
	return commandMetadata.commandNames()
}

function commandArg(name: string): CommandArg | undefined {
	return commandMetadata.commandArg(name)
}

function helpText(commandName = ''): string | null {
	return commandMetadata.helpText(commandName)
}

export const commands = {
	state,
	parseCommand,
	executeCommand,
	writeConfigValue,
	canRunWhileWorking,
	commandNames,
	commandArg,
	helpText,
}
