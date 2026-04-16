// Tab completion for slash commands, models, config keys, and /cd paths.

import { basename, resolve, dirname } from 'path'
import { readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { config as runtimeConfig } from '../config.ts'
import { commands } from '../runtime/commands.ts'

export interface CompletionResult {
	items: string[]
	prefix: string
	start: number
}

type CommandArg = 'model' | 'dir' | 'command' | 'config'

const COMMAND_ARGS: Record<string, CommandArg> = {
	help: 'command',
	model: 'model',
	cd: 'dir',
	config: 'config',
}

function commandNames(): string[] {
	// /raw is handled locally in the CLI, so completion adds it explicitly.
	return [...new Set([...commands.commandNames(), 'raw'])].sort()
}

const config = {
	modelNames: [
		'sonnet',
		'opus',
		'haiku',
		'claude-sonnet-4-20250514',
		'claude-opus-4-20250514',
		'gpt-4o',
		'gpt-4.1',
		'o3',
		'o4-mini',
		'gemini-2.5-pro',
	] as string[],
}

const state = {
	active: false,
	selectedIndex: 0,
	lastResult: null as CompletionResult | null,
}

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

function listDirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => {
				if (entry.name.startsWith('.')) return false
				if (entry.isDirectory()) return true
				if (entry.isSymbolicLink()) {
					try {
						return statSync(resolve(dir, entry.name)).isDirectory()
					} catch {
						return false
					}
				}
				return false
			})
			.map((entry) => entry.name)
			.sort()
	} catch {
		return []
	}
}

function completeDirs(argPrefix: string, cwd: string): string[] {
	const expanded = expandTilde(argPrefix)

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
	const matching = prefix ? dirs.filter((dir) => dir.startsWith(prefix)) : dirs
	const base = expanded.endsWith('/')
		? argPrefix
		: argPrefix === ''
			? ''
			: argPrefix.includes('/')
				? argPrefix.slice(0, argPrefix.lastIndexOf('/') + 1)
				: ''

	return matching.map((dir) => base + dir + '/')
}

function listConfigPaths(): string[] {
	const out: string[] = []

	function visit(prefix: string, value: unknown): void {
		out.push(prefix)
		if (!value || typeof value !== 'object' || Array.isArray(value)) return
		for (const key of Object.keys(value as Record<string, any>).sort()) {
			visit(`${prefix}.${key}`, (value as Record<string, any>)[key])
		}
	}

	for (const name of Object.keys(runtimeConfig.modules).sort()) {
		visit(name, runtimeConfig.modules[name])
	}
	return out
}

function complete(text: string, cursor: number): CompletionResult | null {
	if (cursor < 0 || cursor > text.length) cursor = text.length
	const before = text.slice(0, cursor)
	if (!before.startsWith('/')) return null
	if (before.includes('\n')) return null

	const body = before.slice(1)
	const hasSpace = /[ \t]$/.test(before)
	const trimmed = body.trim()
	const parts = trimmed ? trimmed.split(/\s+/) : []

	if (parts.length === 0 || (parts.length === 1 && !hasSpace)) {
		const needle = parts[0] ?? ''
		const names = commandNames()
		const matches = names.filter((name) => name.startsWith(needle))
		if (matches.length === 0) return null

		const items = matches.map((name) => `/${name}`)
		const prefix = longestCommonPrefix(items)
		return { items, prefix, start: 0 }
	}

	const command = parts[0]!
	const arg = COMMAND_ARGS[command]
	if (!arg) return null
	if (parts.length > 2) return null

	const argPrefix = hasSpace ? '' : (parts[1] ?? '')
	let values: string[] = []

	if (arg === 'model') {
		values = config.modelNames.filter((model) => model.startsWith(argPrefix))
	} else if (arg === 'dir') {
		values = completeDirs(argPrefix, process.cwd())
	} else if (arg === 'command') {
		values = commandNames().filter((name) => name.startsWith(argPrefix))
	} else {
		values = listConfigPaths().filter((path) => path.startsWith(argPrefix))
	}

	if (values.length === 0) return null

	const items = values.map((value) => `/${command} ${value}`)
	const prefix = longestCommonPrefix(items)
	return { items, prefix, start: 0 }
}

function apply(text: string, cursor: number, item: string): { text: string; cursor: number } {
	const after = text.slice(cursor)
	const isDirCompletion = item.match(/^\/cd\s/) && item.endsWith('/')
	const suffix = isDirCompletion ? '' : ' '
	const newText = item + suffix + after
	const newCursor = item.length + suffix.length
	return { text: newText, cursor: newCursor }
}

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

export const completion = {
	config,
	state,
	complete,
	apply,
	cycle,
	dismiss,
	selectedItem,
}
