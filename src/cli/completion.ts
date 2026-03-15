import { basename, resolve, dirname } from 'path'
import { readdirSync, statSync, existsSync } from 'fs'
import { homedir } from 'os'
import { models } from '../models.ts'
import { SESSIONS_DIR } from '../state.ts'

export interface CompletionTab {
	sessionId: string
	info?: {
		topic?: string
		workingDir?: string
	}
}

export interface CompletionContext {
	tabs: CompletionTab[]
	activeTabIndex: number
}

export interface CompletionResult {
	text: string
	cursor: number
	options: string[]
}

interface CommandSpec {
	name: string
	arg?: 'model' | 'session' | 'topic' | 'dir' | 'closed_session'
}

const COMMANDS: CommandSpec[] = [
	{ name: 'help' },
	{ name: 'reset' },
	{ name: 'compact' },
	{ name: 'model', arg: 'model' },
	{ name: 'topic', arg: 'topic' },
	{ name: 'cd', arg: 'dir' },
	{ name: 'continue' },
	{ name: 'resume', arg: 'closed_session' },
	{ name: 'open', arg: 'session' },
	{ name: 'fork' },
	{ name: 'pause' },
	{ name: 'close' },
	{ name: 'respond' },
]

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function longestCommonPrefix(values: string[]): string {
	if (values.length === 0) return ''
	let prefix = values[0]
	for (let i = 1; i < values.length; i++) {
		while (prefix.length > 0 && !values[i].startsWith(prefix)) prefix = prefix.slice(0, -1)
		if (!prefix) break
	}
	return prefix
}

function commandSpec(name: string): CommandSpec | undefined {
	return COMMANDS.find(c => c.name === name)
}

function commandNames(): string[] {
	return uniqueSorted(COMMANDS.map(c => c.name))
}

function expandTilde(p: string): string {
	if (p === '~') return homedir()
	if (p.startsWith('~/')) return homedir() + p.slice(1)
	return p
}

function collapseTilde(p: string): string {
	const home = homedir()
	if (p === home) return '~'
	if (p.startsWith(home + '/')) return '~' + p.slice(home.length)
	return p
}

function listDirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter(e => {
				if (e.name.startsWith('.')) return false
				if (e.isDirectory()) return true
				// Follow symlinks to check if target is a directory
				if (e.isSymbolicLink()) try { return statSync(resolve(dir, e.name)).isDirectory() } catch { return false }
				return false
			})
			.map(e => e.name)
			.sort()
	} catch { return [] }
}

function commandArgValues(command: string, ctx: CompletionContext, argPrefix = ''): string[] {
	const spec = commandSpec(command)
	if (!spec?.arg) return []
	switch (spec.arg) {
		case 'model':
			return models.modelCompletions()
		case 'session':
			return uniqueSorted(ctx.tabs.map(t => t.sessionId))
		case 'topic': {
			const active = ctx.tabs[ctx.activeTabIndex]
			const topic = active?.info?.topic?.trim()
			if (topic) return [topic]
			const wd = active?.info?.workingDir?.trim()
			if (wd) return [basename(wd)]
			return []
		}
		case 'closed_session': {
			const openIds = new Set(ctx.tabs.map(t => t.sessionId))
			try {
				return readdirSync(SESSIONS_DIR)
					.filter(d => !openIds.has(d) && existsSync(resolve(SESSIONS_DIR, d, 'session.ason')))
					.sort().reverse()
			} catch { return [] }
		}
		case 'dir': {
			const active = ctx.tabs[ctx.activeTabIndex]
			const cwd = active?.info?.workingDir ?? process.cwd()
			const expanded = expandTilde(argPrefix)
			const useTilde = argPrefix.startsWith('~')

			// If prefix ends with '/', list that directory
			// Otherwise, list parent and filter by basename prefix
			let searchDir: string
			let prefix: string
			if (expanded.endsWith('/') || expanded === '') {
				searchDir = expanded === '' ? cwd : resolve(cwd, expanded)
				prefix = ''
			} else {
				searchDir = resolve(cwd, dirname(expanded))
				prefix = basename(expanded)
			}

			const dirs = listDirs(searchDir)
			const matching = prefix ? dirs.filter(d => d.startsWith(prefix)) : dirs

			// Build full paths relative to what the user typed
			const base = expanded.endsWith('/') ? argPrefix
				: argPrefix === '' ? ''
				: argPrefix.includes('/') ? argPrefix.slice(0, argPrefix.lastIndexOf('/') + 1)
				: ''

			return matching.map(d => {
				const full = base + d + '/'
				return useTilde ? full : full
			})
		}
	}
}

export function completeInput(input: string, cursor: number, ctx: CompletionContext): CompletionResult | null {
	if (cursor < 0 || cursor > input.length) cursor = input.length
	const before = input.slice(0, cursor)
	const after = input.slice(cursor)
	if (!before.startsWith('/')) return null
	if (before.includes('\n') || before.includes('\r')) return null

	const body = before.slice(1)
	const hasTrailingSpace = /[ \t]$/.test(before)
	const trimmed = body.trim()
	const parts = trimmed ? trimmed.split(/\s+/) : []

	const applyUnique = (value: string): CompletionResult => {
		const text = `${value} ${after}`
		return { text, cursor: value.length + 1, options: [value] }
	}

	if (parts.length === 0 || (parts.length === 1 && !hasTrailingSpace)) {
		const needle = parts[0] ?? ''
		const matches = commandNames().filter(n => n.startsWith(needle))
		const options = matches.map(n => `/${n}`)
		if (options.length === 0) return null
		if (options.length === 1) return applyUnique(options[0])
		const common = longestCommonPrefix(options)
		const next = common.length > before.length ? common : before
		return { text: next + after, cursor: next.length, options }
	}

	const command = parts[0]
	const spec = commandSpec(command)
	if (!spec?.arg) return null

	const argPrefix = hasTrailingSpace ? '' : parts[parts.length - 1]
	if (!argPrefix && parts.length > 1 && !hasTrailingSpace) return null
	if (parts.length > 2) return null

	const values = commandArgValues(command, ctx, argPrefix)
	const matches = values.filter(v => v.startsWith(argPrefix))
	const options = matches.map(v => `/${command} ${v}`)
	if (options.length === 0) return null
	if (options.length === 1) {
		const value = options[0]
		// For dir completion, don't add trailing space — let user keep tabbing deeper
		if (spec.arg === 'dir') return { text: value + after, cursor: value.length, options }
		return applyUnique(options[0])
	}

	const common = longestCommonPrefix(matches)
	const completedArg = common.length > argPrefix.length ? common : argPrefix
	const next = `/${command} ${completedArg}`
	return { text: next + after, cursor: next.length, options }
}

export const completion = { completeInput }
