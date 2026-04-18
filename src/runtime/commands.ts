// Slash commands — parsed from user input starting with '/'.
//
// Commands are processed BEFORE sending to the agent loop. If a command
// is recognized, it's handled directly and the prompt is not forwarded
// to the model.

import { existsSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { ipc } from '../ipc.ts'
import { models } from '../models.ts'
import { ason } from '../utils/ason.ts'
import { config } from '../config.ts'
import { context } from './context.ts'
import { sessions as sessionStore } from '../server/sessions.ts'
import { inbox } from './inbox.ts'
import { anthropicUsage } from '../anthropic-usage.ts'
import { openaiUsage } from '../openai-usage.ts'
import { memory } from '../memory.ts'
import { version } from '../version.ts'

// ── Types ──

export interface CommandResult {
	/** Text output to show the user (info level). */
	output?: string
	/** Error message to show the user. */
	error?: string
	/** Whether the command was recognized and handled. */
	handled: boolean
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
) => CommandResult | Promise<CommandResult>

type CommandArg = 'model' | 'dir' | 'command' | 'config'

interface CommandSpec {
	usage?: string
	summary: string
	detail?: string
	help?: string
	arg?: CommandArg
}

const handlers: Record<string, CommandHandler> = {}

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
	return { output: `Sent to ${target.name} (${target.id})`, handled: true }
}

function closedSessionLines(): string[] {
	const openIds = new Set(sessionStore.loadSessionList())
	const closed = sessionStore
		.loadAllSessionMetas()
		.filter((meta) => !openIds.has(meta.id))
		.sort((a, b) => (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt))
	if (closed.length === 0) return ['No closed sessions.']
	return ['Closed sessions:', ...closed.slice(0, 20).map((meta) => `  ${meta.id}`)]
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
	return meta?.topic || meta?.name || fallbackName
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

// Keep /help output short, and put the fiddly syntax under /help <command>.
function normalizeHelpTopic(args: string): string {
	return args.trim().replace(/^\//, '')
}

const commandSpecs: Record<string, CommandSpec> = {
	model: { usage: '[name]', summary: 'Switch model or list available models.', detail: 'With no name, shows the current model and the available choices.', arg: 'model' },
	clear: { summary: 'Clear session history.' },
	fork: { summary: 'Fork current session to new tab.' },
	open: { usage: '[tab|session-id|name]', summary: 'Open a new tab, optionally after a tab.', detail: 'With no target, opens a new tab at the end. With a target, opens after that tab.' },
	move: { usage: '<position>', summary: 'Move the current tab to a position.', detail: 'Values below 1 clamp to 1; values above the tab count clamp to the last tab.' },
	rename: { usage: '<name>|clear', summary: 'Rename the current session.', detail: 'Set a short session name used in tabs and command targets.' },
	resume: { usage: '[session-id|name]', summary: 'Resume a closed session.', detail: 'With no id, lists recently closed sessions.' },
	tabs: { usage: '[--all]', summary: 'List open tabs; use --all to include closed sessions.' },
	compact: { summary: 'Summarize conversation to reduce context.' },
	raw: { summary: 'Log raw key bytes on this terminal.', detail: 'Keys are logged as bytes until Esc exits.' },
	status: { summary: 'Show Anthropic / OpenAI subscription usage.', detail: 'Shows usage for all configured accounts.' },
	mem: { summary: 'Show current RSS memory and the warn/kill thresholds.' },
	send: { usage: '<tab|session-id|name> <message>', summary: 'Send a message to another tab.', detail: 'Targets can be a tab number, full session id, or session name.' },
	broadcast: { usage: '<message>', summary: 'Send a message to every other tab.', detail: 'Sends the same message to every other open tab.' },
	cd: { usage: '[path]', summary: 'Change working directory.', detail: 'With no path, shows the current working directory.', arg: 'dir' },
	system: { summary: 'Show full preprocessed system prompt.' },
	config: {
		summary: 'View or change config.',
		arg: 'config',
		help: [
			'/config',
			'Show current live config.',
			'',
			'/config <module-or-path>',
			'Show one section or key.',
			'',
			'/config <module-or-path> <value>',
			'Write a value to config.ason and apply it now.',
			'',
			'/config <module-or-path> --temp <value>',
			'/config --temp <module-or-path> <value>',
			'/config <module-or-path> <value> --temp',
			'Set a value in memory only.',
			'',
			'Caveat: a later config.ason reload can replace temp values.',
			'',
			'Examples:',
			'  /config',
			'  /config agentLoop',
			'  /config agentLoop.maxIterations',
			'  /config agentLoop.maxIterations 2',
			'  /config agentLoop.maxIterations --temp 2',
		].join('\n'),
	},
	help: { usage: '[cmd]', summary: 'Show help; try /help config.', arg: 'command' },
	exit: { summary: 'Quit Hal.' },
}

function helpUsage(name: string): string {
	const spec = commandSpecs[name]
	if (!spec?.usage) return `/${name}`
	return `/${name} ${spec.usage}`
}

function detailedHelp(topic: string): string | null {
	const spec = commandSpecs[topic]
	if (!spec) return null
	if (spec.help) return spec.help
	const lines = [`Usage: ${helpUsage(topic)}`, '', spec.summary]
	if (spec.detail) lines.push('', spec.detail)
	return lines.join('\n')
}

// /help — list commands or show details for one command
handlers['help'] = (args) => {
	const topic = normalizeHelpTopic(args)
	if (topic) {
		const text = detailedHelp(topic)
		if (!text) return { error: `No detailed help for /${topic}. Try /help.`, handled: true }
		return { output: text, handled: true }
	}
	const names = Object.keys(commandSpecs)
	const width = Math.max(...names.map((name) => helpUsage(name).length))
	const lines = ['Available commands:', ...names.map((name) => `  ${helpUsage(name).padEnd(width)}  ${commandSpecs[name]!.summary}`)]
	return { output: lines.join('\n'), handled: true }
}
// /model [name] — switch model or show current + list
handlers['model'] = (args, session) => {
	if (!args) {
		const current = session.model ?? models.defaultModel()
		const display = models.displayModel(current)
		const lines = [`Current: ${display} (${current})`, '', ...models.listModels()]
		return { output: lines.join('\n'), handled: true }
	}

	const newModel = models.resolveModel(args)
	session.model = newModel
	const display = models.displayModel(newModel)
	return { output: `Model set to ${display} (${newModel})`, handled: true }
}

// /clear — rotate to a fresh log and reset replay context
handlers['clear'] = (_args, session) => {
	ipc.appendCommand({
		type: 'reset',
		sessionId: session.id,
	})
	return { output: 'Conversation cleared.', handled: true }
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

// /status — runtime version + Anthropic / OpenAI OAuth subscription usage
handlers['status'] = async () => {
	const raw = [await anthropicUsage.renderStatus(true), await openaiUsage.renderStatus(true)]
	const sections = raw.filter((text) => !/^No (Anthropic Claude|OpenAI ChatGPT) subscriptions configured\.$/.test(text.trim()))
	const usage = sections.length > 0 ? sections.join('\n\n') : 'No OAuth subscription credentials configured.'
	return {
		output: `${renderRuntimeStatus()}\n\n${usage}`,
		handled: true,
	}
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
handlers['send'] = (args, session) => {
	const trimmed = args.trim()
	if (trimmed === 'all' || trimmed.startsWith('all ')) return handlers['broadcast']!(trimmed.slice(3).trim(), session)
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

// /cd [path] — change working directory
handlers['cd'] = (args, session) => {
	if (!args) {
		return { output: `cwd: ${session.cwd}`, handled: true }
	}

	// Expand ~ to home directory
	const raw = args.replace(/^~(?=$|\/)/, homedir())
	const target = resolve(session.cwd, raw)

	if (!existsSync(target)) {
		return { error: `cd failed: ${target}: not found`, handled: true }
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
	return { output: parts.join('\n'), handled: true }
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

// /config — inspect or change runtime config
handlers['config'] = (args) => {
	const parsed = parseConfigArgs(args)
	if (parsed.help) return { output: detailedHelp('config')!, handled: true }
	if (!parsed.path) return { output: `Current config:\n${ason.stringify(config.snapshot(), 'long')}`, handled: true }
	if (!parsed.value) {
		const read = config.readPath(parsed.path)
		if (read.error) return { error: read.error, handled: true }
		return { output: `${parsed.path}:\n${ason.stringify(read.value, 'long')}`, handled: true }
	}
	try {
		const value = config.parseValue(parsed.path, parsed.value)
		const write = config.writePath(parsed.path, value, { temp: parsed.temp })
		if (write.error) return { error: write.error, handled: true }
		return { output: write.output, handled: true }
	} catch (err: any) {
		return { error: `/config: could not parse value: ${err?.message ?? String(err)}`, handled: true }
	}
}



// /exit — quit
handlers['exit'] = () => {
	// Give a brief moment for cleanup, then exit
	setTimeout(() => process.exit(0), 100)
	return { output: 'Goodbye.', handled: true }
}


// ── Main dispatch ──

/** Execute a slash command. Returns { handled: false } if not a command. */
async function executeCommand(text: string, session: SessionState): Promise<CommandResult> {
	const parsed = parseCommand(text)
	if (!parsed) return { handled: false }

	const handler = handlers[parsed.name]
	if (!handler) {
		return { error: `Unknown command: /${parsed.name}. Type /help for help.`, handled: true }
	}

	return await handler(parsed.args, session)
}

/** Get list of command names (for tab completion and /help topics). */
function commandNames(): string[] {
	return Object.keys(commandSpecs)
}

function commandArg(name: string): CommandArg | undefined {
	return commandSpecs[name]?.arg
}

export const commands = {
	parseCommand,
	executeCommand,
	commandNames,
	commandArg,
}
