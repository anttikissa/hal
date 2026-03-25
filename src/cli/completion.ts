// Tab completion for slash commands, model names, and file paths.
// Ported and simplified from prev/src/cli/completion.ts.
//
// Usage: completion.complete(text, cursor) returns a result with matching
// items and a common prefix. completion.apply() inserts the chosen item.

import { basename, resolve, dirname } from 'path'
import { readdirSync, statSync } from 'fs'
import { homedir } from 'os'

// ── Types ────────────────────────────────────────────────────────────────────

export interface CompletionResult {
	items: string[]   // display items (e.g. "/model", "/help")
	prefix: string    // longest common prefix among items
	start: number     // offset in the original text where prefix begins
}

interface CommandSpec {
	name: string
	arg?: 'model' | 'dir'
}

// ── Known commands ───────────────────────────────────────────────────────────

const COMMANDS: CommandSpec[] = [
	{ name: 'help' },
	{ name: 'reset' },
	{ name: 'compact' },
	{ name: 'model', arg: 'model' },
	{ name: 'cd', arg: 'dir' },
	{ name: 'continue' },
	{ name: 'fork' },
	{ name: 'tab' },
	{ name: 'close' },
	{ name: 'system' },
	{ name: 'show' },
	{ name: 'clear' },
	{ name: 'exit' },
]

// ── Config ───────────────────────────────────────────────────────────────────

const config = {
	// Known model strings for /model completion. Will be replaced by
	// a proper model registry once providers are wired up.
	modelNames: [
		'sonnet', 'opus', 'haiku',
		'claude-sonnet-4-20250514', 'claude-opus-4-20250514',
		'gpt-4o', 'gpt-4.1', 'o3', 'o4-mini',
		'gemini-2.5-pro',
	] as string[],
}

// ── State ────────────────────────────────────────────────────────────────────
// Tracks which item is selected in the popup so arrow/tab can cycle.

const state = {
	active: false,
	selectedIndex: 0,
	lastResult: null as CompletionResult | null,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function longestCommonPrefix(values: string[]): string {
	if (values.length === 0) return ''
	let prefix = values[0]!
	for (let i = 1; i < values.length; i++) {
		while (prefix.length > 0 && !values[i]!.startsWith(prefix)) {
			prefix = prefix.slice(0, -1)
		}
		if (!prefix) break
	}
	return prefix
}

function expandTilde(p: string): string {
	if (p === '~') return homedir()
	if (p.startsWith('~/')) return homedir() + p.slice(1)
	return p
}

// List directories (not hidden) in a given path
function listDirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter(e => {
				if (e.name.startsWith('.')) return false
				if (e.isDirectory()) return true
				// Follow symlinks to check if target is directory
				if (e.isSymbolicLink()) {
					try { return statSync(resolve(dir, e.name)).isDirectory() }
					catch { return false }
				}
				return false
			})
			.map(e => e.name)
			.sort()
	} catch { return [] }
}

// Complete directory paths for /cd
function completeDirs(argPrefix: string, cwd: string): string[] {
	const expanded = expandTilde(argPrefix)
	const useTilde = argPrefix.startsWith('~')

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

	// Build paths relative to what the user typed
	const base = expanded.endsWith('/') ? argPrefix
		: argPrefix === '' ? ''
		: argPrefix.includes('/') ? argPrefix.slice(0, argPrefix.lastIndexOf('/') + 1)
		: ''

	return matching.map(d => base + d + '/')
}

// ── Main completion logic ────────────────────────────────────────────────────

function complete(text: string, cursor: number): CompletionResult | null {
	if (cursor < 0 || cursor > text.length) cursor = text.length
	const before = text.slice(0, cursor)
	if (!before.startsWith('/')) return null
	// Don't complete in multiline input
	if (before.includes('\n')) return null

	const body = before.slice(1)
	const hasSpace = /[ \t]$/.test(before)
	const trimmed = body.trim()
	const parts = trimmed ? trimmed.split(/\s+/) : []

	// Case 1: completing the command name itself (e.g. "/he" or "/")
	if (parts.length === 0 || (parts.length === 1 && !hasSpace)) {
		const needle = parts[0] ?? ''
		const names = COMMANDS.map(c => c.name).sort()
		const matches = names.filter(n => n.startsWith(needle))
		if (matches.length === 0) return null

		const items = matches.map(n => `/${n}`)
		const prefix = longestCommonPrefix(items)
		return { items, prefix, start: 0 }
	}

	// Case 2: completing command argument
	const command = parts[0]!
	const spec = COMMANDS.find(c => c.name === command)
	if (!spec?.arg) return null
	if (parts.length > 2) return null

	const argPrefix = hasSpace ? '' : (parts[1] ?? '')
	let values: string[] = []

	if (spec.arg === 'model') {
		values = config.modelNames.filter(m => m.startsWith(argPrefix))
	} else if (spec.arg === 'dir') {
		values = completeDirs(argPrefix, process.cwd())
	}

	if (values.length === 0) return null

	const items = values.map(v => `/${command} ${v}`)
	const prefix = longestCommonPrefix(items)
	return { items, prefix, start: 0 }
}

// Apply a completion: replace text from result.start with the chosen item.
// Returns the new text and cursor position.
function apply(
	text: string, cursor: number, item: string,
): { text: string; cursor: number } {
	const after = text.slice(cursor)
	// For dir completions, don't add trailing space (let user tab deeper)
	const isDirCompletion = item.match(/^\/cd\s/) && item.endsWith('/')
	const suffix = isDirCompletion ? '' : ' '
	const newText = item + suffix + after
	const newCursor = item.length + suffix.length
	return { text: newText, cursor: newCursor }
}

// Cycle selection through items. dir: +1 for next, -1 for previous.
function cycle(dir: 1 | -1): void {
	if (!state.lastResult || state.lastResult.items.length === 0) return
	const len = state.lastResult.items.length
	state.selectedIndex = (state.selectedIndex + dir + len) % len
}

function dismiss(): void {
	state.active = false
	state.selectedIndex = 0
	state.lastResult = null
}

function selectedItem(): string | null {
	if (!state.active || !state.lastResult) return null
	return state.lastResult.items[state.selectedIndex] ?? null
}

// ── Namespace ────────────────────────────────────────────────────────────────

export const completion = {
	config,
	state,
	complete,
	apply,
	cycle,
	dismiss,
	selectedItem,
}
