// Shared slash-command metadata used by command execution and client help/completion.

import { visLen } from '../utils/strings.ts'

export type CommandArg = 'model' | 'dir' | 'command' | 'config' | 'login-provider' | 'closed-session'

interface CommandSpec {
	usage?: string | string[]
	summary: string
	detail?: string
	help?: string
	arg?: CommandArg
}

interface CommandSection {
	title: string
	names: string[]
}

// Keep /help output short, and put the fiddly syntax under /help <command>.
function normalizeHelpCommand(args: string): string {
	return args.trim().replace(/^\//, '')
}

const commandSpecs: Record<string, CommandSpec> = {
	model: { usage: '[<model>]', summary: 'Switch model or list available models.', detail: 'With no model, shows the current model and the available choices.', arg: 'model' },
	clear: { summary: 'Clear session history.' },
	clients: { summary: 'List server and connected client versions.' },
	check: { summary: 'Check models.dev for model metadata and alias updates.' },
	fork: { summary: 'Fork current session to new tab.' },
	self: { usage: '[--fork | -f]', summary: 'Open a session in Hal\'s own directory.', detail: 'With --fork, fork this conversation into Hal\'s own directory instead of starting a fresh self tab.' },
	open: { usage: '[<target>]', summary: 'Open a new tab, optionally after a tab.', detail: 'With no target, opens a new tab at the end. With a target, opens after that tab.' },
	move: { usage: '<position>', summary: 'Move the current tab to a position.', detail: 'Values below 1 clamp to 1; values above the tab count clamp to the last tab.' },
	rename: { usage: ['<name…>', 'clear'], summary: 'Rename or clear the current session name.', detail: 'Set a short session name used in tabs and command targets.' },
	resume: { usage: '[<target>]', summary: 'Resume a closed session.', detail: 'With no target, lists recently closed sessions.', arg: 'closed-session' },
	tabs: { usage: '[--all]', summary: 'List open tabs; use --all to include closed sessions.' },
	compact: { summary: 'Summarize conversation to reduce context.' },
	history: { summary: 'Show the active session history file.' },
	rebase: { summary: 'Rewrite session history (similar to `git rebase -i`).' },
	status: { summary: 'Show Claude / ChatGPT subscription usage.', detail: 'Shows usage for all configured accounts.' },
	login: {
		usage: '<claude | chatgpt> [<code>]',
		summary: 'Log in to Claude or ChatGPT via OAuth.',
		arg: 'login-provider',
		help: [
			'/login claude',
			'  Open the Claude OAuth page. After authorizing, copy the code',
			'  shown on the redirect page and paste it back as:',
			'  /login claude <code#state>',
			'',
			'/login chatgpt',
			'  Open the ChatGPT OAuth page; the local callback server catches',
			'  the redirect and saves your tokens automatically.',
			'',
			'The old names anthropic and openai still work.',
		].join('\n'),
	},
	mem: { summary: 'Show current RSS memory and the warn/kill thresholds.' },
	pause: { summary: 'Pause at the next local tool batch before running tools.' },
	send: { usage: '<target> <message…>', summary: 'Send a message to another tab.', detail: 'Target can be a tab number, full session id, or session name.' },
	queue: { usage: ['<prompt…>', 'next', 'clear'], summary: 'Queue, run, clear, or list queued prompts.', detail: 'With no prompt, lists queued prompts. /queue next (or Ctrl-Q) runs queued prompts. /queue clear removes all queued prompts.' },
	broadcast: { usage: '<message…>', summary: 'Send a message to every other tab.', detail: 'Sends the same message to every other open tab.' },
	cd: { usage: '[<path>]', summary: 'Change working directory.', detail: 'With no path, changes to Hal\'s own directory.', arg: 'dir' },
	system: { summary: 'Show full preprocessed system prompt.' },
	config: {
		summary: 'View or change config.',
		arg: 'config',
		help: [
			'/config',
			'Show current live config.',
			'',
			'/config <module-or-path>',
			'Show one section or key.',
			'',
			'/config <module-or-path> <value>',
			'Write a value to config.ason and apply it now.',
			'',
			'/config <module-or-path> --temp <value>',
			'/config --temp <module-or-path> <value>',
			'/config <module-or-path> <value> --temp',
			'Set a value in memory only.',
			'',
			'Caveat: a later config.ason reload can replace temp values.',
			'',
			'Examples:',
			'  /config',
			'  /config agentLoop',
			'  /config agentLoop.maxIterations',
			'  /config agentLoop.maxIterations 2',
			'  /config agentLoop.maxIterations --temp 2',
		].join('\n'),
	},
	help: { usage: '[<command>]', summary: 'Show help; try /help config.', arg: 'command' },
	web: { usage: ['', 'auth [<purpose…>]', 'revoke <number>'], summary: 'Show or manage web interface access tokens.', detail: 'With no arguments, shows authenticated local web URLs. New tokens are independent browser/device capabilities.' },
	quit: { summary: 'Quit Hal.' },
	exit: { summary: 'Quit Hal.' },
}

const commandSections: CommandSection[] = [
	{ title: 'Common', names: ['exit', 'help', 'model', 'pause', 'quit', 'status'] },
	{ title: 'Conversation', names: ['clear', 'compact', 'history', 'rebase', 'system'] },
	{ title: 'Tabs & sessions', names: ['fork', 'move', 'open', 'rename', 'resume', 'self', 'tabs'] },
	{ title: 'Messaging & queue', names: ['broadcast', 'queue', 'send'] },
	{ title: 'Setup & diagnostics', names: ['cd', 'check', 'clients', 'config', 'login', 'mem', 'web'] },
]

function helpUsageLines(name: string): string[] {
	const spec = commandSpecs[name]
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


function sortedCommandNames(names: string[]): string[] {
	const sorted = [...names]
	sorted.sort()
	return sorted
}

function padVisible(text: string, width: number): string {
	return text + ' '.repeat(Math.max(0, width - visLen(text)))
}

function helpCommandLines(name: string, width: number): string[] {
	const lines: string[] = []
	for (const usage of helpUsageLines(name)) {
		lines.push(`  ${padVisible(usage, width)}  ${commandSpecs[name]!.summary}`)
	}
	return lines
}

function syntaxLegend(): string[] {
	return [
		'Syntax:',
		'  literal          type exactly as shown: clear, next, --all',
		'  <value>          required value',
		'  [value]          optional item/group',
		'  a | b            choose one',
		'  <text…>          rest of line; may contain spaces',
		'  <target>         tab number, session id, or session name',
	]
}

function commandListHelp(): string {
	let width = 0
	for (const section of commandSections) {
		for (const name of section.names) {
			for (const usage of helpUsageLines(name)) {
				width = Math.max(width, visLen(usage))
			}
		}
	}

	const lines = ['Available commands:', '', ...syntaxLegend()]
	for (const section of commandSections) {
		lines.push('', `${section.title}:`)
		for (const name of sortedCommandNames(section.names)) {
			lines.push(...helpCommandLines(name, width))
		}
	}
	return lines.join('\n')
}

function detailedHelp(commandName: string): string | null {
	const spec = commandSpecs[commandName]
	if (!spec) return null
	if (spec.help) return spec.help
	const lines = ['Usage:']
	for (const line of helpUsageLines(commandName)) {
		lines.push(`  ${line}`)
	}
	lines.push('', spec.summary)
	if (spec.detail) lines.push('', spec.detail)
	return lines.join('\n')
}

function helpText(commandName = ''): string | null {
	const normalized = normalizeHelpCommand(commandName)
	if (normalized) return detailedHelp(normalized)
	return commandListHelp()
}

function commandNames(): string[] {
	return Object.keys(commandSpecs)
}

function commandArg(name: string): CommandArg | undefined {
	return commandSpecs[name]?.arg
}

export const commandMetadata = {
	normalizeHelpCommand,
	commandListHelp,
	detailedHelp,
	commandNames,
	commandArg,
	helpText,
}
