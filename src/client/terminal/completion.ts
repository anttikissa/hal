// Tab completion for slash commands, models, config keys, and /cd paths.

import { basename } from 'path'
import { config as runtimeConfig } from '../../config.ts'
import { commandMetadata } from '../../common/command-metadata.ts'
import { models } from '../../common/models.ts'
import { clientLocalCommands } from '../local-commands.ts'
import { clientTransport } from '../transport.ts'
import { clientBackend } from '../backend.ts'
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
	// Set by complete() when directory names must come from a remote host.
	pending: null as Promise<CompletionResult | null> | null,
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

function cdArgPrefix(before: string, command: string): string {
	const start = 1 + command.length
	return before.slice(start).replace(/^[ \t]/, '')
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
	return [...new Set([...commandMetadata.commandNames(), ...clientLocalCommands.commandNames()])].sort()
}

function addUnique(values: string[], seen: Set<string>, value: string | undefined): void {
	if (!value || seen.has(value)) return
	seen.add(value)
	values.push(value)
}

function sessionTargets(closedOnly = false): string[] {
	const values: string[] = []
	const seen = new Set<string>()
	const openSessions = clientTransport.io.readState().sessions
	const openIds = new Set<string>()
	for (const session of openSessions) {
		openIds.add(session.id)
		if (closedOnly) continue
		addUnique(values, seen, session.id)
		addUnique(values, seen, session.name)
	}
	for (const meta of clientBackend.sessions.loadAllSessionMetas()) {
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
	state.pending = null
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
	const arg = clientLocalCommands.commandArg(command) ?? commandMetadata.commandArg(command)
	if (!arg) return null
	if (parts.length > 2 && arg !== 'dir' && arg !== 'session' && arg !== 'closed-session') return null

	let argPrefix = hasSpace ? '' : (parts[1] ?? '')
	let values: string[] = []

	if (arg === 'model') {
		values = modelNames().filter((model) => model.startsWith(argPrefix))
	} else if (arg === 'dir') {
		argPrefix = cdArgPrefix(before, command)
		const found = clientTransport.io.completeDirs(argPrefix, cwd)
		if (found instanceof Promise) {
			state.pending = found.then((late) => resultFor(command, arg, late), () => null)
			return null
		}
		values = found
	} else if (arg === 'command') {
		values = commandNamesForPrompt().filter((name) => name.startsWith(argPrefix))
	} else if (arg === 'session') {
		argPrefix = cdArgPrefix(before, command)
		values = completeSessionTargets(argPrefix)
	} else if (arg === 'closed-session') {
		argPrefix = cdArgPrefix(before, command)
		values = completeSessionTargets(argPrefix, true)
	} else if (arg === 'login-provider') {
		// Both provider and product names are accepted by /login, so Tab exposes them all.
		values = ['anthropic', 'chatgpt', 'claude', 'openai', 'opencode'].filter((provider) => provider.startsWith(argPrefix))
	} else if (arg === 'web-action') {
		// Bare /web lists the tokens, so only the subcommands need completing.
		values = ['auth', 'revoke'].filter((action) => action.startsWith(argPrefix))
	} else {
		values = runtimeConfig.listPaths().filter((path) => path.startsWith(argPrefix))
	}
	return resultFor(command, arg, values)
}

function resultFor(command: string, arg: string, values: string[]): CompletionResult | null {
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
