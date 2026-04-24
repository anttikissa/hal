// Build the system prompt from SYSTEM.md plus the AGENTS.md / CLAUDE.md chain,
// then provide lightweight sizing and watch helpers around that prompt.

import { existsSync, readFileSync, watch } from 'fs'
import { dirname } from 'path'
import { HAL_DIR, STATE_DIR } from '../state.ts'
import { sessions } from '../server/sessions.ts'
import { models } from '../models.ts'
import { tokenCalibration } from '../token-calibration.ts'
import type { Message, ContentBlock } from '../protocol.ts'

// ── AGENTS.md loading ─────────────────────────────────────────────────────────

type AgentFileName = 'AGENTS.md' | 'CLAUDE.md'

interface AgentFile {
	path: string
	name: AgentFileName
	content: string
	bytes: number
}

interface LoadedPromptFile {
	name: string
	path: string
	bytes: number
}

interface PromptWatchSession {
	sessionId: string
	cwd: string
}

interface PromptWatchChange {
	sessionId: string
	name: 'SYSTEM.md' | AgentFileName
	path: string
}

function halDir(): string {
	// Read env at call time so tests and future runtime reload hooks can swap the
	// location without re-importing this module.
	return process.env.HAL_DIR ?? HAL_DIR
}

function stateDir(): string {
	// Same rule as halDir(): do not capture paths once at import time if the
	// caller expects live reconfiguration.
	return process.env.HAL_STATE_DIR ?? STATE_DIR
}

function systemPromptPath(): string {
	return `${halDir()}/SYSTEM.md`
}

/** Walk up from `from` to find the nearest .git directory. */
function findGitRoot(from: string): string | null {
	if (existsSync(`${from}/.git`)) return from
	const parent = dirname(from)
	// Reached filesystem root without finding .git
	if (parent === from) return null
	return findGitRoot(parent)
}

/** Build the chain of directories from root down to cwd (inclusive). */
function directoryChain(cwd: string, root: string): string[] {
	const dirs: string[] = [cwd]
	let dir = cwd
	while (dir !== root) {
		dir = dirname(dir)
		dirs.unshift(dir)
	}
	return dirs
}

/** Read an AGENTS.md or CLAUDE.md file from a directory. Tries AGENTS.md first. */
function readAgentFile(dir: string): AgentFile | null {
	for (const name of ['AGENTS.md', 'CLAUDE.md'] as const) {
		const path = `${dir}/${name}`
		try {
			const content = readFileSync(path, 'utf-8')
			return { path, name, content, bytes: Buffer.byteLength(content) }
		} catch {
			// File doesn't exist or can't be read — try next
		}
	}
	return null
}

/** Collect all agent files from git root down to cwd. */
function collectAgentFiles(cwd: string): AgentFile[] {
	const root = findGitRoot(cwd) ?? cwd
	return directoryChain(cwd, root)
		.map(readAgentFile)
		.filter((f): f is AgentFile => f !== null)
}

/** Return directories that should be watched for AGENTS.md changes. */
function agentWatchDirs(cwd: string): string[] {
	const root = findGitRoot(cwd) ?? cwd
	return directoryChain(cwd, root)
}

// ── Directive processing ──────────────────────────────────────────────────────
// Supports ::: if key="glob" ... ::: conditional blocks in agent files.

function processDirectives(text: string, vars: Record<string, string>): string {
	const lines = text.split('\n')
	const out: string[] = []
	let skip = false
	for (const line of lines) {
		// Opening directive: ::: if model="claude*"
		const open = line.match(/^:{3,}\s+if\s+(\w+)="([^"]+)"\s*$/)
		if (open) {
			const key = open[1] ?? ''
			const pattern = open[2] ?? ''
			const val = vars[key] ?? ''
			const re = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
			skip = !re.test(val)
			continue
		}
		// Closing directive: :::
		if (/^:{3,}\s*$/.test(line)) {
			skip = false
			continue
		}
		if (!skip) out.push(line)
	}
	return out.join('\n')
}

// ── System prompt builder ─────────────────────────────────────────────────────

interface SystemPromptResult {
	text: string
	loaded: LoadedPromptFile[]
	bytes: number
}

function buildSystemPrompt(opts: {
	model?: string
	cwd?: string
	sessionId?: string
}): SystemPromptResult {
	const model = opts.model ?? ''
	const cwd = opts.cwd ?? process.cwd()
	const sessionDir = opts.sessionId ? sessions.sessionDir(opts.sessionId) : ''
	const currentHalDir = halDir()
	const currentStateDir = stateDir()
	const d = new Date()
	const date = `${d.toISOString().slice(0, 10)}, ${d.toLocaleDateString('en-US', { weekday: 'long' })}`

	// Variables available for substitution in agent files
	const vars: Record<string, string> = {
		model,
		date,
		cwd,
		hal_dir: currentHalDir,
		state_dir: currentStateDir,
		session_dir: sessionDir,
	}

	// Substitute ${var} placeholders
	const sub = (s: string) =>
		s
			.replace(/\$\{model\}/g, model)
			.replace(/\$\{cwd\}/g, cwd)
			.replace(/\$\{date\}/g, date)
			.replace(/\$\{hal_dir\}/g, currentHalDir)
			.replace(/\$\{state_dir\}/g, currentStateDir)
			.replace(/\$\{session_dir\}/g, sessionDir)

	const parts: string[] = []
	const loaded: LoadedPromptFile[] = []

	// Load SYSTEM.md from hal dir (the base system prompt)
	try {
		let text = readFileSync(systemPromptPath(), 'utf-8')
		const bytes = Buffer.byteLength(text)
		// Strip HTML comments
		text = text.replace(/<!--[\s\S]*?-->/g, '')
		parts.push(text)
		loaded.push({ name: 'SYSTEM.md', path: systemPromptPath(), bytes })
	} catch {
		parts.push('You are a helpful coding assistant.')
	}

	// Walk git root → cwd, collecting AGENTS.md (or CLAUDE.md fallback)
	for (const agent of collectAgentFiles(cwd)) {
		parts.push(agent.content)
		loaded.push({ name: agent.name, path: agent.path, bytes: agent.bytes })
	}

	parts.push([
		'Transcript markup:',
		'- <meta>...</meta> messages are Hal-generated environment/session metadata, not user-authored text.',
		'- <synthetic>...</synthetic> messages are Hal-generated assistant messages, not LLM output.',
	].join('\n'))

	// Process directives and substitute variables, then collapse excess newlines
	const text = parts
		.map((p) => processDirectives(p, vars))
		.map(sub)
		.join('\n\n')
		.replace(/\n{3,}/g, '\n\n')

	return { text, loaded, bytes: Buffer.byteLength(text) }
}

// ── Prompt file watching ──────────────────────────────────────────────────────

let promptWatchers: Array<{ close: () => void }> = []

function addWatcher(path: string, onSignal: (eventType: string, filename?: string) => void): void {
	try {
		const watcher = watch(path, { persistent: false }, (eventType, filename) => onSignal(eventType, filename ?? undefined))
		promptWatchers.push(watcher)
	} catch {
		// Missing directories/files are normal while watching prompt sources.
	}
}

function stopPromptWatchers(): void {
	for (const watcher of promptWatchers.splice(0)) {
		try { watcher.close() } catch {}
	}
}

function watchPromptFiles(sessionsToWatch: PromptWatchSession[], onChange: (change: PromptWatchChange) => void): () => void {
	stopPromptWatchers()
	const pending = new Map<string, ReturnType<typeof setTimeout>>()
	const systemDir = dirname(systemPromptPath())
	let stopped = false

	function queue(change: PromptWatchChange): void {
		if (stopped) return
		const key = `${change.sessionId}:${change.path}`
		const old = pending.get(key)
		if (old) clearTimeout(old)
		pending.set(key, setTimeout(() => {
			pending.delete(key)
			if (!stopped) onChange(change)
		}, 50))
	}

	for (const session of sessionsToWatch) {
		// Watch the global SYSTEM.md directory once per session. Keeping the callback
		// session-scoped makes it easy for the runtime to emit a visible info block
		// into every affected tab when the base prompt changes.
		addWatcher(systemDir, (_eventType, filename) => {
			const name = String(filename ?? '')
			if (name && name !== 'SYSTEM.md') return
			queue({ sessionId: session.sessionId, name: 'SYSTEM.md', path: systemPromptPath() })
		})

		for (const dir of agentWatchDirs(session.cwd)) {
			addWatcher(dir, (_eventType, filename) => {
				const name = String(filename ?? '')
				if (name === 'AGENTS.md' || name === 'CLAUDE.md') {
					queue({ sessionId: session.sessionId, name: name as AgentFileName, path: `${dir}/${name}` })
					return
				}
				if (name) return
				const agent = readAgentFile(dir)
				if (!agent) return
				queue({ sessionId: session.sessionId, name: agent.name, path: agent.path })
			})
		}
	}

	return () => {
		stopped = true
		for (const timer of pending.values()) clearTimeout(timer)
		pending.clear()
		stopPromptWatchers()
	}
}

function resetForTests(): void {
	stopPromptWatchers()
}

// ── Message building ──────────────────────────────────────────────────────────

/** Estimate byte size of a message (for rough token estimation). */
function messageBytes(msg: Message): number {
	if (typeof msg.content === 'string') return msg.content.length
	if (Array.isArray(msg.content)) {
		let bytes = 0
		for (const block of msg.content) {
			if (block.type === 'text') bytes += block.text?.length ?? 0
			else if (block.type === 'thinking') bytes += block.thinking?.length ?? 0
			else if (block.type === 'tool_use') bytes += JSON.stringify(block.input ?? {}).length
			else if (block.type === 'tool_result') {
				bytes +=
					typeof block.content === 'string'
						? block.content.length
						: JSON.stringify(block.content ?? '').length
			}
		}
		return bytes
	}
	return 0
}

/** Estimate total tokens for a list of messages + overhead. */
function estimateContext(
	messages: Message[],
	modelId: string,
	overheadBytes = 0,
): { used: number; max: number; estimated: true } {
	let totalBytes = Math.max(0, overheadBytes)
	for (const msg of messages) totalBytes += messageBytes(msg)
	const max = models.contextWindow(modelId)
	return { used: tokenCalibration.estimateTokens(totalBytes, modelId), max, estimated: true as const }
}

/** Format byte counts for display. */
function formatBytes(n: number): string {
	if (n < 1024) return `${n}B`
	return `${(n / 1024).toFixed(1)}KB`
}

export const context = {
	buildSystemPrompt,
	collectAgentFiles,
	agentWatchDirs,
	findGitRoot,
	watchPromptFiles,
	messageBytes,
	estimateContext,
	formatBytes,
	__resetForTests: resetForTests,
}
