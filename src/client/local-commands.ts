import { keyHelp } from '../cli/key-help.ts'
import { visLen } from '../utils/strings.ts'
import { commands } from '../runtime/commands.ts'
import { sessions as sessionStore } from '../server/sessions.ts'
import type { CommandType } from '../protocol.ts'

export interface ClientLocalTabRef {
	sessionId: string
	name: string
}

export interface ClientLocalCommandContext {
	tabs: ClientLocalTabRef[]
	activeTab: number
	switchTab: (index: number) => void
	sendCommand: (type: CommandType, text?: string) => void
}

export interface ClientLocalCommandResult {
	handled: boolean
	output?: string
	error?: string
	quit?: boolean
}

type ClientLocalCommandHandler = (args: string, ctx: ClientLocalCommandContext) => ClientLocalCommandResult

type ClientLocalCommandArg = 'command'

interface ClientLocalCommandSpec {
	usage?: string | string[]
	summary: string
	detail?: string
	arg?: ClientLocalCommandArg
	run: ClientLocalCommandHandler
}

interface ParsedCommand {
	name: string
	args: string
}

interface GoMatch {
	kind: 'open' | 'closed'
	index: number
	sessionId: string
	name: string
}

const specs: Record<string, ClientLocalCommandSpec> = {}

function parse(text: string): ParsedCommand | null {
	const trimmed = text.trim()
	if (!trimmed.startsWith('/')) return null
	const space = trimmed.indexOf(' ')
	if (space === -1) return { name: trimmed.slice(1), args: '' }
	return { name: trimmed.slice(1, space), args: trimmed.slice(space + 1).trim() }
}

function normalize(text: string): string {
	return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

function displayName(tab: ClientLocalTabRef): string {
	return tab.name || tab.sessionId
}

function openMatchForTab(tab: ClientLocalTabRef, index: number): GoMatch {
	return { kind: 'open', index, sessionId: tab.sessionId, name: displayName(tab) }
}

function exactOpenMatch(raw: string, ctx: ClientLocalCommandContext): GoMatch | null {
	if (/^\d+$/.test(raw)) {
		const index = parseInt(raw, 10) - 1
		const tab = ctx.tabs[index]
		if (tab) return openMatchForTab(tab, index)
		return null
	}

	for (let i = 0; i < ctx.tabs.length; i++) {
		const tab = ctx.tabs[i]!
		if (tab.sessionId === raw) return openMatchForTab(tab, i)
	}

	const needle = normalize(raw)
	for (let i = 0; i < ctx.tabs.length; i++) {
		const tab = ctx.tabs[i]!
		if (normalize(displayName(tab)) === needle) return openMatchForTab(tab, i)
	}

	return null
}

function partialOpenMatches(raw: string, ctx: ClientLocalCommandContext): GoMatch[] {
	const needle = normalize(raw)
	const matches: GoMatch[] = []
	for (let i = 0; i < ctx.tabs.length; i++) {
		const tab = ctx.tabs[i]!
		if (normalize(displayName(tab)).includes(needle)) matches.push(openMatchForTab(tab, i))
	}
	return matches
}

function closedMatches(raw: string, ctx: ClientLocalCommandContext): GoMatch[] {
	const openIds = new Set<string>()
	for (const tab of ctx.tabs) openIds.add(tab.sessionId)

	const needle = normalize(raw)
	const matches: GoMatch[] = []
	for (const meta of sessionStore.loadAllSessionMetas()) {
		if (openIds.has(meta.id)) continue
		const name = meta.name || meta.id
		if (meta.id === raw || normalize(name) === needle || normalize(name).includes(needle)) {
			matches.push({ kind: 'closed', index: -1, sessionId: meta.id, name })
		}
	}
	return matches
}

function formatMatches(matches: GoMatch[]): string {
	const lines: string[] = []
	for (const match of matches) {
		const where = match.kind === 'open' ? `tab ${match.index + 1}` : 'closed'
		lines.push(`  ${where} ${match.sessionId}  ${match.name}`)
	}
	return lines.join('\n')
}

function runGo(args: string, ctx: ClientLocalCommandContext): ClientLocalCommandResult {
	const raw = args.trim()
	if (!raw) return { handled: true, error: 'Usage: /go <target>' }

	const exact = exactOpenMatch(raw, ctx)
	if (exact) {
		if (exact.index === ctx.activeTab) return { handled: true, output: `Already on tab ${exact.index + 1}: ${exact.name}` }
		ctx.switchTab(exact.index)
		return { handled: true, output: `Switched to tab ${exact.index + 1}: ${exact.name}` }
	}

	const open = partialOpenMatches(raw, ctx)
	if (open.length === 1) {
		const match = open[0]!
		if (match.index === ctx.activeTab) return { handled: true, output: `Already on tab ${match.index + 1}: ${match.name}` }
		ctx.switchTab(match.index)
		return { handled: true, output: `Switched to tab ${match.index + 1}: ${match.name}` }
	}
	if (open.length > 1) return { handled: true, error: `Ambiguous /go target: ${raw}\n${formatMatches(open)}` }

	const closed = closedMatches(raw, ctx)
	if (closed.length === 1) {
		const match = closed[0]!
		ctx.sendCommand('resume', match.sessionId)
		return { handled: true, output: `Resuming ${match.name} (${match.sessionId})...` }
	}
	if (closed.length > 1) return { handled: true, error: `Ambiguous closed session: ${raw}\n${formatMatches(closed)}` }

	return { handled: true, error: `No tab or session matches: ${raw}` }
}

function runKeys(_args: string, _ctx: ClientLocalCommandContext): ClientLocalCommandResult {
	return { handled: true, output: keyHelp.render() }
}

function runQuit(_args: string, _ctx: ClientLocalCommandContext): ClientLocalCommandResult {
	return { handled: true, output: 'Goodbye.', quit: true }
}


function helpUsageLines(name: string): string[] {
	const spec = specs[name]
	if (!spec?.usage) return [`/${name}`]
	if (Array.isArray(spec.usage)) {
		const lines: string[] = []
		for (const usage of spec.usage) {
			lines.push(`/${name} ${usage}`)
		}
		return lines
	}
	return [`/${name} ${spec.usage}`]
}

function helpUsage(name: string): string {
	return helpUsageLines(name)[0]!
}

function padVisible(text: string, width: number): string {
	return text + ' '.repeat(Math.max(0, width - visLen(text)))
}

function localCommandHelp(): string {
	let width = 0
	for (const name of clientLocalCommands.commandNames()) {
		for (const usage of helpUsageLines(name)) {
			width = Math.max(width, visLen(usage))
		}
	}

	const lines = ['Terminal-local commands:']
	for (const name of clientLocalCommands.commandNames()) {
		const spec = specs[name]!
		for (const usage of helpUsageLines(name)) {
			lines.push(`  ${padVisible(usage, width)}  ${spec.summary}`)
		}
	}
	return lines.join('\n')
}

function detailedHelp(name: string): string | null {
	const spec = specs[name]
	if (!spec) return null
	const lines = [`Usage: ${helpUsage(name)}`, '', spec.summary]
	if (spec.detail) lines.push('', spec.detail)
	return lines.join('\n')
}

function combinedHelp(): string {
	const serverHelp = commands.helpText('') ?? 'Available commands:'
	return [serverHelp, localCommandHelp(), 'Keyboard shortcuts:', '  Type /keys for the full terminal shortcut reference.'].join('\n\n')
}

function runHelp(args: string, _ctx: ClientLocalCommandContext): ClientLocalCommandResult {
	const commandName = args.trim().replace(/^\//, '')
	if (!commandName) return { handled: true, output: combinedHelp() }
	if (commandName === 'keys') return { handled: true, output: keyHelp.render() }

	const local = detailedHelp(commandName)
	if (local) return { handled: true, output: local }

	const server = commands.helpText(commandName)
	if (server) return { handled: true, output: server }
	return { handled: true, error: `No detailed help for /${commandName}. Try /help.` }
}

function execute(text: string, ctx: ClientLocalCommandContext): ClientLocalCommandResult {
	const parsed = clientLocalCommands.parse(text)
	if (!parsed) return { handled: false }
	const spec = specs[parsed.name]
	if (!spec) return { handled: false }
	return spec.run(parsed.args, ctx)
}

function commandNames(): string[] {
	return Object.keys(specs).sort()
}

function commandArg(name: string): ClientLocalCommandArg | undefined {
	return specs[name]?.arg
}

specs['go'] = {
	usage: '<target>',
	summary: 'Switch this terminal to a tab or resume a matching closed session.',
	detail: 'Target can be a tab number, session id, or session name. Exact matches are preferred, then partial open/closed session names.',
	run: runGo,
}

specs['help'] = {
	usage: '[<command>]',
	summary: 'Show combined server, terminal-local, and keyboard help.',
	arg: 'command',
	run: runHelp,
}

specs['keys'] = {
	summary: 'Show terminal keyboard shortcuts.',
	run: runKeys,
}

specs['quit'] = {
	summary: 'Quit this terminal.',
	run: runQuit,
}

specs['exit'] = {
	summary: 'Quit this terminal.',
	run: runQuit,
}

export const clientLocalCommands = {
	parse,
	execute,
	commandNames,
	commandArg,
	localCommandHelp,
	detailedHelp,
	combinedHelp,
}
