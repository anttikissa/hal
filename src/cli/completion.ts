import { basename } from 'path'
import { modelCompletions } from '../models.ts'

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
	arg?: 'model' | 'session' | 'topic'
}

const COMMANDS: CommandSpec[] = [
	{ name: 'help' },
	{ name: 'reset' },
	{ name: 'compact' },
	{ name: 'model', arg: 'model' },
	{ name: 'topic', arg: 'topic' },
	{ name: 'continue' },
	{ name: 'resume' },
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

function commandArgValues(command: string, ctx: CompletionContext): string[] {
	const spec = commandSpec(command)
	if (!spec?.arg) return []
	switch (spec.arg) {
		case 'model':
			return modelCompletions()
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

	const values = commandArgValues(command, ctx)
	const matches = values.filter(v => v.startsWith(argPrefix))
	const options = matches.map(v => `/${command} ${v}`)
	if (options.length === 0) return null
	if (options.length === 1) return applyUnique(options[0])

	const common = longestCommonPrefix(matches)
	const completedArg = common.length > argPrefix.length ? common : argPrefix
	const next = `/${command} ${completedArg}`
	return { text: next + after, cursor: next.length, options }
}
