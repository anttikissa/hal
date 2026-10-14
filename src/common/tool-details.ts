// A tool call in readable text, relevant parts once (AGENTS.md "UI:
// visible plumbing", tasks 8t, 18n): a headline for the card's head, and the
// lines an open card adds without repeating it. Bash reads like the
// terminal; call IDs, argument types and defaults stay in session files.
//
// Plugin surface (toolDetails.*):
// - headline(name, input): a card's closed title and the argument it shows
//   bash → its description; command → "/rename …"; read → "Read src/main.ts"
// - lines(name, input): what an open card adds below the title
//   bash → "$ <command>" ("&" when backgrounded), "Edits a.ts, b.ts",
//   "Timeout 30 s" when not the default; other tools → "key: value"
//   for each argument the title didn't show
// - value(input): any argument as readable lines, not JSON
//   "" → "(empty string)", [] → "(empty list)", objects as "key:" blocks
//
// Example: plugin.around(toolDetails, 'headline', (next, name, input) =>
//   name === 'bash' ? { text: `$ ${input.command}`, key: 'command' } : next(name, input))

import { callText } from './call-text.ts'
import { home } from './home.ts'
import { titles } from './titles.ts'

// A value in readable text rather than wire syntax.
function value(input: unknown, indent = ''): string[] {
	if (typeof input === 'string') return input === '' ? ['(empty string)'] : input.split('\n')
	if (input === null) return ['(null)']
	if (Array.isArray(input)) return input.length ? input.flatMap((v, i) => {
		let lines = toolDetails.value(v, indent + '  ')
		return [`${indent}${i + 1}. ${lines[0]}`, ...lines.slice(1).map((l) => `${indent}   ${l}`)]
	}) : ['(empty list)']
	if (typeof input === 'object') return Object.entries(input).length ? Object.entries(input).flatMap(([key, v]) => [
		`${indent}${key}:`, ...toolDetails.value(v, indent + '  ').map((l) => `  ${l}`),
	]) : ['(empty object)']
	return [String(input)]
}

let oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

// A card's title: what the call does, in words (task jz). Each tool
// reads as a verb and its object: Google "words", Read <path or
// URL>, Inspect project (tab, id), Spawn "name" (tab 3, 31-swe),
// Wait for 31-swe, 31-bux. Bash shows the model's description, marked
// (background) when backgrounded; its command opens below. A
// model-run slash command reads as typed, "/rename …" (task 9g).
// `output`: the call's result, when known, adds what only the host
// knew (the tab and id spawn opened, whom wait waits for). `key` and
// `keys` name the arguments shown, which lines() then leaves out.
function headline(name: string, input: Record<string, unknown>, output?: string): { text: string; key?: string; keys?: string[] } {
	let head = titled(name, input, output)
	return { ...head, text: home.short(head.text) }
}

function titled(name: string, input: Record<string, unknown>, output?: string): { text: string; key?: string; keys?: string[] } {
	let str = (k: string) => (typeof input[k] === 'string' && oneLine(input[k] as string)) || undefined
	// [tab, id] of each session the result names (tabs.label).
	let ids = (re: RegExp) => [...(output ?? '').matchAll(re)].map((m) => [m[1], m[2]!] as const)
	switch (name) {
		case 'tool': {
			try {
				let parsed = callText.parse(input.cmd)
				let purpose = /^\s*\/\*([\s\S]*?)\*\//.exec(parsed.raw)?.[1]?.trim()
				let fields: Record<string, unknown> = {}
				try {
					let args = callText.values(parsed.raw)
					purpose = args.purpose ?? purpose
					let first = args.values[0]
					if (Array.isArray(first) && first.length === 1) first = first[0]
					if (first && typeof first === 'object' && !Array.isArray(first)) fields = first as Record<string, unknown>
				} catch {}
				return { text: purpose ? `${verb(parsed.name)} ${oneLine(purpose)}` : titled(parsed.name, fields).text }
			} catch { break }
		}
		case 'bash': {
			let text = `Bash ${str('description') ?? oneLine(String(input.command ?? '').split('\n')[0]!)}`.trimEnd()
			return { text: input.background === true ? `${text} (background)` : text, key: str('description') ? 'description' : undefined }
		}
		case 'send': {
			let to = str('to')
			if (!to) break
			let sent = output?.match(/^(?:Sent to|Queued in|Waiting in|Interrupted) (.+?)(?=: it |$)/)?.[1]
			let target = sent ? titles.address(sent, true) : /^\d+$/.test(to) ? `tab ${to}` : to
			let command = typeof input.text === 'string' && /^\s*\//.test(input.text) ? str('text') : undefined
			return { text: `${command ? `${command} → ` : 'To '}${target}${str('description') ? `: ${str('description')}` : ''}`, keys: ['to', 'description', ...(command ? ['text'] : [])] }
		}
		case 'command':
			if (str('command')) return { text: str('command')!, key: 'command' }
			break
		case 'google':
			if (str('query')) return { text: `Google "${str('query')}"`, key: 'query' }
			break
		case 'read':
		case 'read_blob': {
			if (name === 'read' && Array.isArray(input.paths)) return { text: `Read ${input.paths.length} file${input.paths.length === 1 ? '' : 's'}` }
			if (name === 'read_blob' && Array.isArray(input.ids)) return { text: `Read blobs ${input.ids.join(', ')}` }
			let key = name === 'read_blob' ? 'id' : str('url') ? 'url' : 'path'
			if (str(key)) return { text: `${name === 'read_blob' ? 'Read blob' : 'Read'} ${str(key)}`, key }
			break
		}
		case 'notify':
			if (str('text')) return { text: `Notify "${str('text')}"`, key: 'text' }
			break
		case 'write':
			if (str('path')) return { text: `Write ${str('path')}`, key: 'path' }
			break
		// The file, then the purpose; the diff opens below (task ese).
		case 'edit':
			if (str('path')) return { text: `Edit ${str('path')}${str('description') ? `: ${str('description')}` : ''}`, keys: ['path', 'hash', 'description'] }
			break
		case 'inspect': {
			if (input.target !== undefined) return typeof input.target === 'string' || typeof input.target === 'number' ? { text: `Inspect ${String(input.target)}`, key: 'target' } : { text: 'Inspect' }
			if (![input.what, input.scope, input.fields].every((v) => v === undefined || typeof v === 'string')) break
			let what = (input.what as string | undefined) ?? 'sessions'
			let target = what === 'sessions' ? (input.scope as string | undefined) ?? 'self' : what
			let fields = (input.fields as string | undefined)?.split(',').map((f) => f.trim()).filter(Boolean)
			let text = `Inspect ${target}${what !== 'sessions' && input.scope !== undefined ? ` ${input.scope}` : ''}${fields?.length ? ` (${fields.join(', ')})` : ''}`
			return { text, keys: ['what', 'scope', 'fields'] }
		}
		case 'spawn': {
			let what = str('name') ? `"${str('name')}"` : input.kind === 'interactive' ? 'interactive session' : 'subagent'
			let at = ids(/^(?:Started|Opened) (?:tab (\d+) · )?(\d+-[a-z]+)/g).map(([tab, id]) => (tab ? `tab ${tab}, ${id}` : id))[0]
			return { text: `Spawn ${what}${at ? ` (${at})` : ''}`, keys: str('name') ? ['name'] : [] }
		}
		case 'stop':
			if (input.target !== undefined) return typeof input.target === 'string' || typeof input.target === 'number' ? { text: `Stop ${String(input.target)}`, key: 'target' } : { text: 'Stop' }
			break
		case 'wait': {
			if (input.targets !== undefined) {
				let targets = Array.isArray(input.targets) ? input.targets : [input.targets]
				if (!targets.every((v) => typeof v === 'string' || typeof v === 'number')) return { text: 'Wait for background work' }
				return { text: `Wait for ${targets.length ? targets.join(', ') : 'background work'}`, key: 'targets' }
			}
			if (output?.startsWith('No owned background command or subagent') || output?.startsWith('No subagent')) return { text: 'Wait (no background work running)' }
			let ready = output?.match(/^Work needs attention: (.+?)\. Inspect the targets;/)?.[1]
			let who = ids(/(?:^Waiting for |, )(?:tab (\d+) · )?(\d+-[a-z]+)/g).map(([, id]) => id)
			return { text: `Wait for ${ready ?? (who.length ? who.join(', ') : 'background work')}` }
		}
	}
	if (str('description')) return { text: `${verb(name)} ${str('description')}`, key: 'description' }
	let first = Object.entries(input).find(([, v]) => typeof v === 'string' && oneLine(v))
	return first ? { text: `${verb(name)} ${oneLine(first[1] as string)}`, key: first[0] } : { text: verb(name) }
}

// A tool's name as the word its title starts with (task hyt): 'Bash',
// 'Read url'.
function verb(name: string): string {
	return (name.charAt(0).toUpperCase() + name.slice(1)).replaceAll('_', ' ')
}

function lines(name: string, input: Record<string, unknown>): string[] {
	let out: string[] = []
	let shown = new Set<string>()
	let head = toolDetails.headline(name, input)
	// The open head wraps, so a one-line headline argument is not repeated.
	let complete = (key: string) => typeof input[key] === 'string' && (input[key] as string).trim() !== '' && !(input[key] as string).includes('\n')
	if (head.key && (complete(head.key) || head.key === 'target' && typeof input.target === 'number' && Number.isSafeInteger(input.target) && input.target > 0)) shown.add(head.key)
	for (let k of head.keys ?? []) if (complete(k)) shown.add(k)
	if (name === 'wait' && head.key === 'targets' && (Array.isArray(input.targets) ? input.targets : [input.targets]).every((v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 || typeof v === 'string' && v.trim() !== '' && !v.includes('\n'))) shown.add('targets')
	if (name === 'read' && Array.isArray(input.paths) && input.paths.every((p) => p && typeof p === 'object' && !Array.isArray(p))) {
		for (let p of input.paths) out.push(toolDetails.headline('read', p).text, ...toolDetails.lines('read', p))
		shown.add('paths')
	}
	if (name === 'bash') {
		let { command, modifies, background, timeout } = input
		if (typeof command === 'string') {
			let [first, ...rest] = command.split('\n')
			out.push(`${background === true ? '&' : '$'} ${first}`, ...rest.map((l) => `  ${l}`))
			shown.add('command')
		}
		let files = typeof modifies === 'string' ? [modifies] : Array.isArray(modifies) && modifies.every((f) => typeof f === 'string') ? modifies : undefined
		if (files) {
			if (files.length) out.push(`Edits ${files.join(', ')}`)
			shown.add('modifies')
		}
		if (typeof background === 'boolean') shown.add('background')
		// The title's "unsafe to stop" label shows it (toolDetails.unsafe).
		if (typeof input.unsafeToStop === 'boolean') shown.add('unsafeToStop')
		if (typeof timeout === 'number') {
			if (timeout !== (background === true ? 600_000 : 120_000)) out.push(`Timeout ${timeout / 1000} s`)
			shown.add('timeout')
		}
	}
	for (let [key, v] of Object.entries(input)) {
		if (shown.has(key)) continue
		let [first, ...rest] = toolDetails.value(v)
		out.push(`${key}: ${first}`, ...rest.map((l) => `  ${l}`))
	}
	return out
}

// A bash call flagged unsafeToStop: its title says "unsafe to stop" (task ker).
const unsafe = (name: string, input: Record<string, unknown>): boolean => name === 'bash' && input.unsafeToStop === true

// Built-in tools that change nothing (host tools.readOnly): an edit of
// a prompt before them leaves the world as it was.
const readOnly: ReadonlySet<string> = new Set(['read', 'inspect', 'google', 'wait', 'help'])

// Discovery and history commands open directly to their complete output (18n).
const fullCommand = (name: string, input: Record<string, unknown>): boolean => name === 'command' && typeof input.command === 'string' && /^\s*\/(?:help|rebase)(?:\s|$)/.test(input.command)

const harmless = (name: string, input: Record<string, unknown>): boolean => readOnly.has(name) || (name === 'command' && typeof input.command === 'string' && /^\s*\/(?:rename|help)(?:\s|$)/.test(input.command))

export const toolDetails = { fullCommand, value, headline, lines, unsafe, readOnly, harmless }
