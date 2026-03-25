// Context builder — system prompt construction and message building.
//
// Loads AGENTS.md / CLAUDE.md files from git root down to cwd,
// builds the system prompt with variable substitution, and provides
// message building + token estimation for context window management.

import { existsSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { HAL_DIR, STATE_DIR } from '../state.ts'
import { models } from '../models.ts'
import type { Message, ContentBlock } from '../protocol.ts'

// ── AGENTS.md loading ──

type AgentFileName = 'AGENTS.md' | 'CLAUDE.md'

interface AgentFile {
	path: string
	name: AgentFileName
	content: string
	bytes: number
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

// ── Directive processing ──
// Supports ::: if key="glob" ... ::: conditional blocks in agent files.

function processDirectives(text: string, vars: Record<string, string>): string {
	const lines = text.split('\n')
	const out: string[] = []
	let skip = false
	for (const line of lines) {
		// Opening directive: ::: if model="claude*"
		const open = line.match(/^:{3,}\s+if\s+(\w+)="([^"]+)"\s*$/)
		if (open) {
			const val = vars[open[1]] ?? ''
			const re = new RegExp('^' + open[2].replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
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

// ── System prompt builder ──

interface SystemPromptResult {
	text: string
	loaded: { name: string; path: string; bytes: number }[]
	bytes: number
}

function buildSystemPrompt(opts: {
	model?: string
	cwd?: string
	sessionDir?: string
}): SystemPromptResult {
	const model = opts.model ?? ''
	const cwd = opts.cwd ?? process.cwd()
	const d = new Date()
	const date = `${d.toISOString().slice(0, 10)}, ${d.toLocaleDateString('en-US', { weekday: 'long' })}`

	// Variables available for substitution in agent files
	const vars: Record<string, string> = {
		model, date, cwd, hal_dir: HAL_DIR,
		state_dir: STATE_DIR,
		session_dir: opts.sessionDir ?? '',
	}

	// Substitute ${var} placeholders
	const sub = (s: string) => s
		.replace(/\$\{model\}/g, model)
		.replace(/\$\{cwd\}/g, cwd)
		.replace(/\$\{date\}/g, date)
		.replace(/\$\{hal_dir\}/g, HAL_DIR)
		.replace(/\$\{state_dir\}/g, STATE_DIR)
		.replace(/\$\{session_dir\}/g, opts.sessionDir ?? '')

	const parts: string[] = []
	const loaded: { name: string; path: string; bytes: number }[] = []

	// Load SYSTEM.md from hal dir (the base system prompt)
	try {
		let text = readFileSync(`${HAL_DIR}/SYSTEM.md`, 'utf-8')
		const bytes = Buffer.byteLength(text)
		// Strip HTML comments
		text = text.replace(/<!--[\s\S]*?-->/g, '')
		parts.push(text)
		loaded.push({ name: 'SYSTEM.md', path: `${HAL_DIR}/SYSTEM.md`, bytes })
	} catch {
		parts.push('You are a helpful coding assistant.')
	}

	// Walk git root → cwd, collecting AGENTS.md (or CLAUDE.md fallback)
	for (const agent of collectAgentFiles(cwd)) {
		parts.push(agent.content)
		loaded.push({ name: agent.name, path: agent.path, bytes: agent.bytes })
	}

	// Process directives and substitute variables, then collapse excess newlines
	const text = parts
		.map(p => processDirectives(p, vars))
		.map(sub)
		.join('\n\n')
		.replace(/\n{3,}/g, '\n\n')

	return { text, loaded, bytes: Buffer.byteLength(text) }
}

// ── Message building ──

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
				bytes += typeof block.content === 'string'
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
	// ~4 chars per token is a rough approximation
	return { used: Math.ceil(totalBytes / 4), max, estimated: true as const }
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
	messageBytes,
	estimateContext,
	formatBytes,
}
