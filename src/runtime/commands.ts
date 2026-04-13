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
import { openaiUsage } from '../openai-usage.ts'
import { memory } from '../memory.ts'

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
	emitInfo: (text: string, level?: 'info' | 'error') => void,
) => CommandResult | Promise<CommandResult>

const handlers: Record<string, CommandHandler> = {}

function parseSendArgs(args: string): { target: string; text: string } | null {
	const spaceIdx = args.indexOf(' ')
	if (spaceIdx === -1) return null
	const target = args.slice(0, spaceIdx).trim()
	const text = args.slice(spaceIdx + 1).trim()
	if (!target || !text) return null
	return { target, text }
}

function resolveSendTarget(session: SessionState, raw: string): SessionRef | null {
	const sessions = session.sessions ?? []
	if (/^\d+$/.test(raw)) {
		const index = parseInt(raw, 10) - 1
		return sessions[index] ?? null
	}
	return sessions.find((item) => item.id === raw) ?? null
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

// Keep /help output short, and put the fiddly syntax under /help <command>.
function normalizeHelpTopic(args: string): string {
	return args.trim().replace(/^\//, '')
}

function detailedHelp(topic: string): string | null {
	if (topic === 'config') {
		return [
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
		].join('\n')
	}
	if (topic === 'model') {
		return ['Usage: /model [name]', '', 'With no name, shows the current model and the available choices.'].join('\n')
	}
	if (topic === 'send') {
		return ['Usage: /send <tab|session-id> <message>', '', 'Targets can be a tab number like 2 or a full session id.'].join(
			'\n',
		)
	}
	if (topic === 'broadcast') {
		return ['Usage: /broadcast <message>', '', 'Sends the same message to every other open tab.'].join('\n')
	}
	if (topic === 'status' || topic === 'usage') {
		return ['Usage: /status', '', 'Show OpenAI ChatGPT subscription usage for all configured accounts.'].join('\n')
	}
	if (topic === 'mem') {
		return ['Usage: /mem', '', 'Show current RSS memory and the warn/kill thresholds.'].join('\n')
	}
	if (topic === 'cd') {
		return ['Usage: /cd [path]', '', 'With no path, shows the current working directory.'].join('\n')
	}
	if (topic === 'resume') {
		return ['Usage: /resume [session-id]', '', 'With no id, lists recently closed sessions.'].join('\n')
	}
	return null
}

// /help — list commands or show details for one command
handlers['help'] = (args) => {
	const topic = normalizeHelpTopic(args)
	if (topic) {
		const text = detailedHelp(topic)
		if (!text) {
			return { error: `No detailed help for /${topic}. Try /help.`, handled: true }
		}
		return { output: text, handled: true }
	}

	const lines = [
		'Available commands:',
		'  /model [name]   Switch model or list available models',
		'  /clear          Clear session history',
		'  /fork           Fork current session to new tab',
		'  /resume [id]    Resume a closed session',
		'  /compact        Summarize conversation to reduce context',
		'  /status         Show ChatGPT subscription usage',
		'  /mem            Show current memory usage and thresholds',
		'  /send <tab|id>  Send a message to another tab',
		'  /broadcast ...  Send a message to every other tab',
		'  /cd [path]      Change working directory',
		'  /system         Show full preprocessed system prompt',
		'  /config [...]   View or change config',
		'  /help [cmd]     Show help; try /help config',
		'  /exit           Quit Hal',
		'  /eval [code]    Run JavaScript in the runtime',
	]
	return { output: lines.join('\n'), handled: true }
}

// /model [name] — switch model or show current + list
handlers['model'] = (args, session, emitInfo) => {
	if (!args) {
		const current = session.model ?? models.defaultModel()
		const display = models.displayModel(current)
		const lines = [`Current: ${display} (${current})`, '', ...models.listModels()]
		return { output: lines.join('\n'), handled: true }
	}

	const oldModel = session.model ?? models.defaultModel()
	const newModel = models.resolveModel(args)
	session.model = newModel
	const display = models.displayModel(newModel)
	return { output: `Model set to ${display} (${newModel})`, handled: true }
}

// /clear — clear session history
handlers['clear'] = (_args, session) => {
	// Emit a clear-history event for the runtime to handle.
	// The actual history clearing happens in the runtime glue (Plan 3 will
	// implement log rotation). For now, just signal it.
	return { output: 'Conversation cleared.', handled: true }
}

// /fork — fork current session to new tab
handlers['fork'] = (_args, session) => {
	// Session forking requires disk operations (Plan 3). Signal intent via IPC.
	ipc.appendCommand({
		type: 'open',
		text: `fork:${session.id}`,
		sessionId: session.id,
	})
	return { handled: true }
}

// /compact — summarize conversation
handlers['compact'] = (_args, session) => {
	ipc.appendCommand({
		type: 'compact',
		sessionId: session.id,
	})
	return { output: 'Compacting conversation...', handled: true }
}

// /status — OpenAI ChatGPT subscription usage
handlers['status'] = async () => {
	return { output: await openaiUsage.renderStatus(true), handled: true }
}

// /usage — Claude Code / Codex-style alias for /status
handlers['usage'] = async (_args, session, emitInfo) => {
	return handlers['status']!('', session, emitInfo)
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

// /resume [id] — list closed sessions or reopen one as a tab
handlers['resume'] = (args, session) => {
	const id = args.trim()
	if (!id) return { output: closedSessionLines().join('\n'), handled: true }
	ipc.appendCommand({ type: 'resume', text: id, sessionId: session.id })
	return { output: `Resuming ${id}...`, handled: true }
}

// /send <tab|session-id> <message> — queue a message for another session
handlers['send'] = (args, session) => {
	const parsed = parseSendArgs(args)
	if (!parsed) return { error: 'Usage: /send <tab|session-id> <message>', handled: true }
	if (parsed.target === 'all') return handlers['broadcast']!(parsed.text, session, () => {})
	const target = resolveSendTarget(session, parsed.target)
	if (!target) {
		return { error: `Unknown tab or session: ${parsed.target}`, handled: true }
	}
	return sendToSession(session, target, parsed.text)
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

function currentConfigSnapshot(): Record<string, any> {
	const snapshot: Record<string, any> = {}
	for (const [name, moduleConfig] of Object.entries(config.modules)) {
		snapshot[name] = moduleConfig
	}
	return snapshot
}

function splitConfigPath(path: string): string[] {
	return path.split('.').filter(Boolean)
}

function readConfigPath(path: string): CommandResult {
	const parts = splitConfigPath(path)
	if (parts.length === 0) return { error: 'Usage: /config [module[.key]] [value] [--temp]', handled: true }
	const root = config.modules[parts[0]!]
	if (!root) return { error: `Unknown config module: ${parts[0]}`, handled: true }

	let value: any = root
	for (const part of parts.slice(1)) {
		if (!value || typeof value !== 'object' || !(part in value)) {
			return { error: `Unknown config key: ${path}`, handled: true }
		}
		value = value[part]
	}

	return { output: `${path}:\n${ason.stringify(value, 'long')}`, handled: true }
}

function liveConfigValue(path: string): any {
	const parts = splitConfigPath(path)
	if (parts.length === 0) return undefined
	let value: any = config.modules[parts[0]!]
	for (const part of parts.slice(1)) {
		if (!value || typeof value !== 'object' || !(part in value)) return undefined
		value = value[part]
	}
	return value
}

function canUseBareStringValue(raw: string): boolean {
	const trimmed = raw.trim()
	if (!trimmed) return false
	if (/\s/.test(trimmed)) return false
	if (/^["'`\[{]/.test(trimmed)) return false
	return true
}

function parseConfigValue(path: string, raw: string): any {
	try {
		return ason.parse(raw)
	} catch (err) {
		// Convenience: if the existing live value is a string, accept a single
		// bare token like `gpt` without forcing quotes.
		if (typeof liveConfigValue(path) === 'string' && canUseBareStringValue(raw)) return raw.trim()
		throw err
	}
}

function ensureConfigObject(root: Record<string, any>, parts: string[]): Record<string, any> | null {
	let node = root
	for (const part of parts) {
		const next = node[part]
		if (next == null) {
			node[part] = {}
			node = node[part]
			continue
		}
		if (!next || typeof next !== 'object' || Array.isArray(next)) return null
		node = next
	}
	return node
}

function setConfigPath(path: string, value: any, temp: boolean): CommandResult {
	const parts = splitConfigPath(path)
	if (parts.length < 2) {
		return { error: 'Set a specific key like agentLoop.maxIterations.', handled: true }
	}

	const moduleName = parts[0]!
	const leaf = parts[parts.length - 1]!
	const parentParts = parts.slice(1, -1)

	if (temp) {
		const moduleConfig = config.modules[moduleName]
		if (!moduleConfig) return { error: `Unknown config module: ${moduleName}`, handled: true }
		const parent = ensureConfigObject(moduleConfig, parentParts)
		if (!parent) return { error: `Cannot write temp config at ${path}`, handled: true }
		parent[leaf] = value
		return { output: `Temporarily set ${path} = ${ason.stringify(value, 'short')}`, handled: true }
	}

	if (!config.modules[moduleName]) {
		return { error: `Unknown config module: ${moduleName}`, handled: true }
	}

	const moduleOverrides = config.data[moduleName]
	if (!moduleOverrides || typeof moduleOverrides !== 'object' || Array.isArray(moduleOverrides)) {
		config.data[moduleName] = {}
	}
	const parent = ensureConfigObject(config.data[moduleName], parentParts)
	if (!parent) return { error: `Cannot write config at ${path}`, handled: true }
	parent[leaf] = value
	config.apply()
	config.save()
	return { output: `Set ${path} = ${ason.stringify(value, 'short')}`, handled: true }
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
	if (!parsed.path) {
		return { output: `Current config:\n${ason.stringify(currentConfigSnapshot(), 'long')}`, handled: true }
	}
	if (!parsed.value) return readConfigPath(parsed.path)

	try {
		const value = parseConfigValue(parsed.path, parsed.value)
		return setConfigPath(parsed.path, value, parsed.temp)
	} catch (err: any) {
		return { error: `/config: could not parse value: ${err?.message ?? String(err)}`, handled: true }
	}
}


// /show — old compatibility shim. Point users at the real commands instead.
handlers['show'] = (args) => {
	const what = args.trim()
	if (!what || what === 'prompt' || what === 'system') {
		return { output: 'Use /system for the full prompt.', handled: true }
	}
	if (what === 'config' || what === 'agentLoop') {
		return { output: 'Use /config or /config agentLoop.', handled: true }
	}
	return { error: 'Use /system for the prompt, /config for config, and /help for commands.', handled: true }
}

// /exit — quit
handlers['exit'] = () => {
	// Give a brief moment for cleanup, then exit
	setTimeout(() => process.exit(0), 100)
	return { output: 'Goodbye.', handled: true }
}

// /eval [code] — run JavaScript in the runtime
handlers['eval'] = async (args, session) => {
	if (!args) {
		return { error: '/eval <code>', handled: true }
	}

	try {
		// eval runs in the current module scope — useful for debugging
		// and hot-patching the runtime.
		const result = await eval(args)
		const text = result === undefined ? '(undefined)' : String(result)
		return { output: text.slice(0, 5000), handled: true }
	} catch (err: any) {
		return { error: `eval error: ${err?.message ?? String(err)}`, handled: true }
	}
}

// ── Main dispatch ──

/** Execute a slash command. Returns { handled: false } if not a command. */
async function executeCommand(
	text: string,
	session: SessionState,
	emitInfo: (text: string, level?: 'info' | 'error') => void,
): Promise<CommandResult> {
	const parsed = parseCommand(text)
	if (!parsed) return { handled: false }

	const handler = handlers[parsed.name]
	if (!handler) {
		return { error: `Unknown command: /${parsed.name}. Type /help for help.`, handled: true }
	}

	return await handler(parsed.args, session, emitInfo)
}

/** Get list of command names (for tab completion). */
function commandNames(): string[] {
	return Object.keys(handlers)
}

export const commands = {
	parseCommand,
	executeCommand,
	commandNames,
}
