// Slash commands — parsed from user input starting with '/'.
//
// Commands are processed BEFORE sending to the agent loop. If a command
// is recognized, it's handled directly and the prompt is not forwarded
// to the model.

import { existsSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { ipc } from '../ipc.ts'
import { protocol } from '../protocol.ts'
import { models } from '../models.ts'
import { context } from './context.ts'
import { agentLoop } from './agent-loop.ts'

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
export interface SessionState {
	id: string
	name: string
	model?: string
	cwd: string
	createdAt: string
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

// /help — list available commands
handlers['help'] = () => {
	const lines = [
		'Available commands:',
		'  /model [name]   Switch model or list available models',
		'  /clear          Clear session history',
		'  /fork           Fork current session to new tab',
		'  /compact        Summarize conversation to reduce context',
		'  /cd [path]      Change working directory',
		'  /system         Show full preprocessed system prompt',
		'  /show [what]    Show system prompt, context, model',
		'  /help           Show this help',
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
		const lines = [
			`Current: ${display} (${current})`,
			'',
			...models.listModels(),
		]
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
	return { output: `Forking session ${session.id}...`, handled: true }
}

// /compact — summarize conversation
handlers['compact'] = (_args, session) => {
	ipc.appendCommand({
		type: 'compact',
		sessionId: session.id,
	})
	return { output: 'Compacting conversation...', handled: true }
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
	const parts = [
		`cwd: ${old} -> ${target}`,
	]
	if (agents.length > 0) {
		const files = agents.map(f => `${f.name} (${context.formatBytes(f.bytes)})`)
		parts.push(`Loaded ${files.join(', ')}`)
	}
	return { output: parts.join('\n'), handled: true }
}

// /system — print the full preprocessed system prompt (SYSTEM.md + AGENTS.md chain)
handlers['system'] = (_args, session) => {
	const model = session.model ?? models.defaultModel()
	const result = context.buildSystemPrompt({ model, cwd: session.cwd })
	const header = result.loaded
		.map(f => `  ${f.name} (${context.formatBytes(f.bytes)}) — ${f.path}`)
		.join('\n')
	return {
		output: `${header}\n  Total: ${context.formatBytes(result.bytes)}\n\n${result.text}`,
		handled: true,
	}
}

// /show [what] — show system prompt, context info, etc.
handlers['show'] = (args, session) => {
	const what = args || 'prompt'

	if (what === 'prompt' || what === 'system') {
		const model = session.model ?? models.defaultModel()
		const result = context.buildSystemPrompt({
			model,
			cwd: session.cwd,
		})
		const lines = [
			`System prompt (${context.formatBytes(result.bytes)}):`,
			'',
		]
		// Show loaded files
		for (const f of result.loaded) {
			lines.push(`  ${f.name} (${context.formatBytes(f.bytes)}) — ${f.path}`)
		}
		lines.push('')
		// Truncate the actual prompt to avoid flooding
		const maxLen = 2000
		if (result.text.length > maxLen) {
			lines.push(result.text.slice(0, maxLen))
			lines.push(`\n... (${result.text.length - maxLen} more chars)`)
		} else {
			lines.push(result.text)
		}
		return { output: lines.join('\n'), handled: true }
	}

	if (what === 'model') {
		const model = session.model ?? models.defaultModel()
		const display = models.displayModel(model)
		const ctxWindow = models.contextWindow(model)
		return {
			output: [
				`Model: ${display} (${model})`,
				`Context window: ${(ctxWindow / 1000).toFixed(0)}k tokens`,
			].join('\n'),
			handled: true,
		}
	}

	if (what === 'context') {
		const model = session.model ?? models.defaultModel()
		const ctxWindow = models.contextWindow(model)
		return {
			output: [
				`Model: ${models.displayModel(model)}`,
				`Context window: ${(ctxWindow / 1000).toFixed(0)}k tokens`,
				`Working dir: ${session.cwd}`,
			].join('\n'),
			handled: true,
		}
	}

	return { error: `/show: unknown topic "${what}". Try: prompt, model, context`, handled: true }
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
