// Tab completion for slash commands, models, config keys, and /cd paths.

import { basename, resolve, dirname } from 'path'
import { readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { config as runtimeConfig } from '../config.ts'
import { commands } from '../runtime/commands.ts'
import { models } from '../models.ts'
import { clientLocalCommands } from '../client/local-commands.ts'
import { ipc } from '../ipc.ts'
import { sessions as sessionStore } from '../server/sessions.ts'
import { completionHints } from './completion-hints.ts'

export interface CompletionResult {
	hints: string[]
	items: string[]
	prefix: string
	start: number
}


const config = {
	modelNames: [] as string[],
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

function cdArgPrefix(before: string, command: string): string {
	const start = 1 + command.length
	return before.slice(start).replace(/^[ \t]/, '')
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

function dirHint(value: string): string {
	const suffix = value.endsWith('/') ? '/' : ''
	const withoutSuffix = suffix ? value.slice(0, -1) : value
	const name = basename(withoutSuffix)
	if (!name) return value
	return name + suffix
}

function modelNames(): string[] {
	return [...new Set([...config.modelNames, ...models.modelCompletionNames()])].sort()
}

function commandNamesForPrompt(): string[] {
	return [...new Set([...commands.commandNames(), ...clientLocalCommands.commandNames()])].sort()
}

function addUnique(values: string[], seen: Set<string>, value: string | undefined): void {
	if (!value || seen.has(value)) return
	seen.add(value)
	values.push(value)
}

function sessionTargets(closedOnly = false): string[] {
	const values: string[] = []
	const seen = new Set<string>()
	const openSessions = ipc.readState().sessions
	const openIds = new Set<string>()
	for (const session of openSessions) {
		openIds.add(session.id)
		if (closedOnly) continue
		addUnique(values, seen, session.id)
		addUnique(values, seen, session.name)
	}
	for (const meta of sessionStore.loadAllSessionMetas()) {
		if (closedOnly && openIds.has(meta.id)) continue
		addUnique(values, seen, meta.id)
		addUnique(values, seen, meta.name)
	}
	return values.sort()
}

function completeSessionTargets(argPrefix: string, closedOnly = false): string[] {
	const needle = argPrefix.toLowerCase()
	return sessionTargets(closedOnly).filter((target) => target.toLowerCase().startsWith(needle))
}


function complete(text: string, cursor: number, cwd = process.cwd()): CompletionResult | null {
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
		const matches = commandNamesForPrompt().filter((name) => name.startsWith(needle))
		if (matches.length === 0) return null

		const items = matches.map((name) => `/${name}`)
		const prefix = longestCommonPrefix(items)
		return { hints: items, items, prefix, start: 0 }
	}

	const command = parts[0]!
	const arg = clientLocalCommands.commandArg(command) ?? commands.commandArg(command)
	if (!arg) return null
	if (parts.length > 2 && arg !== 'dir' && arg !== 'session' && arg !== 'closed-session') return null

	let argPrefix = hasSpace ? '' : (parts[1] ?? '')
	let values: string[] = []

	if (arg === 'model') {
		values = modelNames().filter((model) => model.startsWith(argPrefix))
	} else if (arg === 'dir') {
		argPrefix = cdArgPrefix(before, command)
		values = completeDirs(argPrefix, cwd)
	} else if (arg === 'command') {
		values = commandNamesForPrompt().filter((name) => name.startsWith(argPrefix))
	} else if (arg === 'session') {
		argPrefix = cdArgPrefix(before, command)
		values = completeSessionTargets(argPrefix)
	} else if (arg === 'closed-session') {
		argPrefix = cdArgPrefix(before, command)
		values = completeSessionTargets(argPrefix, true)
	} else if (arg === 'login-provider') {
		values = ['anthropic', 'openai'].filter((provider) => provider.startsWith(argPrefix))
	} else {
		values = runtimeConfig.listPaths().filter((path) => path.startsWith(argPrefix))
	}

	if (values.length === 0) return null

	const items = values.map((value) => `/${command} ${value}`)
	const hints = arg === 'dir' ? values.map((value) => completion.dirHint(value)) : values
	const prefix = longestCommonPrefix(items)
	return { hints, items, prefix, start: 0 }
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
	completionHints.clear()
}

function selectedItem(): string | null {
	if (!state.active || !state.lastResult) return null
	return state.lastResult.items[state.selectedIndex] ?? null
}

export const completion = {
	config,
	state,
	dirHint,
	complete,
	apply,
	cycle,
	dismiss,
	selectedItem,
}
