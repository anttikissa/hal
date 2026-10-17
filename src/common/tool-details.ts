// A tool call in readable text, relevant parts once (AGENTS.md "UI:
// visible plumbing", tasks 8t, 18n): a headline for the card's head, and the
// lines an open card adds without repeating it. Bash reads like the
// terminal; call IDs, argument types and defaults stay in session files.
//
// Plugin surface (toolDetails.*):
// - headline(name, input): a card's closed title and the argument it shows
//   bash → its description; command → "/rename …"; read → "Read src/main.ts"
// - lines(name, input): what an open card adds below the title
//   bash → its command, "Edits a.ts, b.ts",
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
import { transcript, type Item } from './transcript.ts'

// A value in readable text rather than wire syntax: a scalar beside its
// key, lists numbered, nested values indented once per level.
function value(input: unknown): string[] {
	if (typeof input === 'string') return input === '' ? ['(empty string)'] : input.split('\n')
	if (input === null) return ['(null)']
	if (Array.isArray(input)) return input.length ? input.flatMap((v, i) => {
		let lines = toolDetails.value(v)
		return [`${i + 1}. ${lines[0]}`, ...lines.slice(1).map((l) => `   ${l}`)]
	}) : ['(empty list)']
	if (typeof input === 'object') return Object.entries(input).length ? Object.entries(input).flatMap(([key, v]) => {
		let lines = toolDetails.value(v)
		return lines.length === 1 && (v === null || typeof v !== 'object') ? [`${key}: ${lines[0]}`] : [`${key}:`, ...lines.map((l) => `  ${l}`)]
	}) : ['(empty object)']
	return [String(input)]
}

let oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

// A card's title: its tool's mark, then what the call works on (tasks
// jz, b3k): $ <description> for bash (its command opens below), < <paths>,
// > <files>, => <target>, … Waiting for <targets>, ! <text>, * <id> <name>,
// x <target>, ? Help <tool>, ? Inspect <target>. A model-run slash command
// reads as typed, "/rename …" (task 9g); other tools keep their name,
// Google <query>. `output`: the call's result, when known, adds what only
// the host knew (the id spawn opened, whom wait waits for). `mark` is the
// mark the text starts with, which the web draws as an icon; `key` and
// `keys` name the arguments shown, which lines() then leaves out.
type Headline = { text: string; mark?: string; key?: string; keys?: string[] }
function headline(name: string, input: Record<string, unknown>, output?: string): Headline {
	let head = titled(name, input, output)
	let tool = name
	if (name === 'tool') try { tool = callText.parse(input.cmd).name } catch {}
	let mark = marks[tool] && head.text.startsWith(`${marks[tool]} `) ? marks[tool] : undefined
	return { ...head, text: home.short(head.text), ...(mark ? { mark } : {}) }
}

// Each tool's mark (task b3k); tools without one show their name.
const marks: Record<string, string> = { bash: '$', read: '<', read_url: '<', read_blob: '<', read_entry: '<', edit: '>', write: '>', send: 'To', wait: '…', notify: '!', spawn: 'Spawn', stop: 'x', help: '?', inspect: '?' }

function titled(name: string, input: Record<string, unknown>, output?: string): Headline {
	let str = (k: string) => (typeof input[k] === 'string' && oneLine(input[k] as string)) || undefined
	// [tab, id] of each session the result names (tabs.label).
	let ids = (re: RegExp) => [...(output ?? '').matchAll(re)].map((m) => [m[1], m[2]!] as const)
	let marked = (text: string) => `${marks[name]} ${text}`
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
				return { text: purpose ? `${marks[parsed.name] ?? verb(parsed.name)} ${oneLine(purpose)}` : titled(parsed.name, fields).text }
			} catch { break }
		}
		case 'bash':
			return { text: marked(str('description') ?? oneLine(String(input.command ?? '').split('\n')[0]!)).trimEnd(), key: str('description') ? 'description' : undefined }
		case 'send': {
			let to = str('to')
			if (!to) break
			let sent = output?.match(/^(?:Sent to|Queued in|Waiting in|Interrupted) (.+?)(?=: it |$)/)?.[1]
			let [first, sid] = sent?.split(' · ') ?? []
			let target = sent ? /^tab \d+$/.test(first!) && sid ? `${sid} (${first})` : first! : /^\d+$/.test(to) ? `tab ${to}` : to
			let command = typeof input.text === 'string' && /^\s*\//.test(input.text) ? str('text') : undefined
			let preview = str('description') || (typeof input.text === 'string' ? titles.preview(input.text) : undefined)
			return { text: marked(`${target}${command ? ` ${command}` : ''}${preview && preview !== command ? `: ${preview}` : ''}`), keys: ['to', 'description', ...(command ? ['text'] : [])] }
		}
		case 'command':
			if (str('command')) return { text: str('command')!, key: 'command' }
			break
		case 'google':
			if (str('query')) return { text: `Google ${str('query')}`, key: 'query' }
			break
		case 'grep': {
			let paths = [input.in ?? []].flat().filter((p): p is string => typeof p === 'string')
			if (str('pattern')) return { text: `Grep ${JSON.stringify(input.pattern)}${paths.length ? ` in ${paths.join(', ')}` : ''}`, keys: ['pattern', 'in'] }
			break
		}
		case 'web_search':
			if (str('query')) return { text: `Web search ${str('query')}`, key: 'query' }
			if (str('url')) return { text: `Web search ${str('pattern') ? `"${str('pattern')}" in ` : ''}${str('url')}`, key: 'url' }
			break
		case 'read':
		case 'read_url':
		case 'read_blob':
		case 'read_entry': {
			let list = (key: string, many: unknown) => Array.isArray(many) ? many.map((p) => typeof p === 'string' ? p : p && typeof p === 'object' ? (p as Record<string, unknown>)[key] : undefined).filter((p): p is string => typeof p === 'string' && p !== '') : []
			if (name === 'read' && Array.isArray(input.paths)) return { text: marked(list('path', input.paths).map((p) => oneLine(p)).join(', ')) }
			let entries = name === 'read_blob' || name === 'read_entry'
			if (entries && Array.isArray(input.ids)) return { text: marked(list('id', input.ids).join(', ')) }
			let key = entries ? 'id' : str('url') ? 'url' : 'path'
			if (str(key)) return { text: marked(str(key)!), key }
			break
		}
		case 'notify':
			if (str('text')) return { text: marked(str('text')!), key: 'text' }
			break
		case 'write':
			if (str('path')) return { text: marked(str('path')!), key: 'path' }
			break
		// The files it changes; the purpose and diff open below (task ese).
		case 'edit': {
			let files = [...new Set([input.path, ...(Array.isArray(input.edits) ? input.edits.map((e) => e && typeof e === 'object' ? (e as Record<string, unknown>).path : undefined) : [])].filter((p): p is string => typeof p === 'string' && p !== ''))]
			if (files.length) return { text: marked(files.join(', ')), keys: ['path', 'hash'] }
			break
		}
		case 'help':
			return { text: marked(`Help${str('name') ? ` ${str('name')}` : ''}`), key: 'name' }
		case 'inspect': {
			if (input.target !== undefined) return typeof input.target === 'string' || typeof input.target === 'number' ? { text: marked(`Inspect ${String(input.target)}`), key: 'target' } : { text: marked('Inspect') }
			if (![input.what, input.scope, input.fields].every((v) => v === undefined || typeof v === 'string')) break
			let what = (input.what as string | undefined) ?? 'sessions'
			let target = what === 'sessions' ? (input.scope as string | undefined) ?? 'self' : what
			let fields = (input.fields as string | undefined)?.split(',').map((f) => f.trim()).filter(Boolean)
			let text = `Inspect ${target}${what !== 'sessions' && input.scope !== undefined ? ` ${input.scope}` : ''}${fields?.length ? ` (${fields.join(', ')})` : ''}`
			return { text: marked(text), keys: ['what', 'scope', 'fields'] }
		}
		// Spawn <id> (tab N): <name>, then how it ends: a subagent closes
		// when done (autoclose ↧), one left open says nothing.
		case 'spawn': {
			let [tab, at] = ids(/^(?:Started|Opened) (?:tab (\d+) · )?(\d+-[a-z]+)/g)[0] ?? []
			let kind = input.kind === 'interactive' ? 'interactive' : input.kind === 'subagent-leave-open' ? '' : 'autoclose ↧'
			let name = str('name') ?? (at ? '' : input.kind === 'interactive' ? 'Interactive session' : 'Subagent')
			let target = at ? `${at}${tab ? ` (tab ${tab})` : ''}` : ''
			let text = target && name ? `${target}: ${name}` : target || name
			return { text: marked(`${text}${kind ? ` (${kind})` : ''}`), keys: str('name') ? ['name', 'kind'] : ['kind'] }
		}
		case 'stop':
			if (input.target !== undefined) return typeof input.target === 'string' || typeof input.target === 'number' ? { text: marked(String(input.target)), key: 'target' } : { text: marked('Stop') }
			break
		case 'wait': {
			if (input.targets !== undefined) {
				let targets = Array.isArray(input.targets) ? input.targets : [input.targets]
				if (!targets.every((v) => typeof v === 'string' || typeof v === 'number')) return { text: marked('Waiting for background work') }
				return { text: marked(`Waiting for ${targets.length ? targets.join(', ') : 'background work'}`), key: 'targets' }
			}
			if (output?.startsWith('No owned background command or subagent') || output?.startsWith('No subagent')) return { text: marked('Waiting (no background work running)') }
			let ready = output?.match(/^Work needs attention: (.+?)\. Inspect the targets;/)?.[1]
			let who = ids(/(?:^Waiting for |, )(?:tab (\d+) · )?(\d+-[a-z]+)/g).map(([, id]) => id)
			return { text: marked(`Waiting for ${ready ?? (who.length ? who.join(', ') : 'background work')}`) }
		}
	}
	if (str('description')) return { text: `${marks[name] ?? verb(name)} ${str('description')}`, key: 'description' }
	let first = Object.entries(input).find(([, v]) => typeof v === 'string' && oneLine(v))
	return first ? { text: `${marks[name] ?? verb(name)} ${oneLine(first[1] as string)}`, key: first[0] } : { text: marks[name] ? marked(verb(name)) : verb(name) }
}

// A tool's name as its title word (task hyt): 'Google', 'Web search'.
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
	if (name === 'send' && typeof input.text === 'string' && !shown.has('text')) {
		out.push(...input.text.split('\n'))
		shown.add('text')
	}
	if (name === 'bash') {
		let { command, modifies, background, timeout } = input
		if (typeof command === 'string') {
			let [first, ...rest] = command.split('\n')
			out.push(first!, ...rest)
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
		// The title's status shows a timeout off the default (toolDetails.limit).
		if (typeof timeout === 'number') shown.add('timeout')
	}
	for (let [key, v] of Object.entries(input)) {
		if (shown.has(key)) continue
		let [first, ...rest] = toolDetails.value(v)
		if (v && typeof v === 'object' && !Array.isArray(v)) out.push(`${key}:`, `  ${first}`, ...rest.map((l) => `  ${l}`))
		else out.push(`${key}: ${first}`, ...rest.map((l) => `  ${l}`))
	}
	return out
}

// A bash call flagged unsafeToStop: its title says "unsafe to stop" (task ker).
const unsafe = (name: string, input: Record<string, unknown>): boolean => name === 'bash' && input.unsafeToStop === true

// A bash call's timeout off the default, '900s', for its title's
// status: (1.4s / 900s) (task b3k).
function limit(name: string, input: Record<string, unknown>): string | undefined {
	let { timeout } = input
	if (name !== 'bash' || typeof timeout !== 'number' || timeout === (input.background === true ? 600 : 120)) return undefined
	return `${timeout}s`
}

// Built-in tools that change nothing (host tools.readOnly): an edit of
// a prompt before them leaves the world as it was.
const readOnly: ReadonlySet<string> = new Set(['read', 'grep', 'inspect', 'google', 'wait', 'help'])

// Discovery and history commands open directly to their complete output (18n).
const fullCommand = (name: string, input: Record<string, unknown>): boolean => name === 'command' && typeof input.command === 'string' && /^\s*\/(?:help|rebase)(?:\s|$)/.test(input.command)

const harmless = (name: string, input: Record<string, unknown>): boolean => readOnly.has(name) || (name === 'command' && typeof input.command === 'string' && /^\s*\/(?:rename|help)(?:\s|$)/.test(input.command))

// What a wait title names (task zd8), as text and links: each job (t248)
// or session id links to its card or tab, then its description when
// known: the job call's title or the tab's name. Links are web paths; the
// terminal links them to the web app. Undefined for other titles.
type Part = string | { href: string; text: string }
function waiting(title: string, session: string, items: readonly Item[], tabs: readonly { id: string; name: string }[] = []): Part[] | undefined {
	let lead = /^(?:… )?Waiting for /.exec(title)?.[0]
	if (!lead) return undefined
	let parts: Part[] = [lead]
	title.slice(lead.length).split(', ').forEach((ref, i) => {
		if (i) parts.push(', ')
		let job = /^#?t(\d+)$/.exec(ref)?.[1]
		let href = job ? transcript.href(session, `t${job}`) : /^\d+-[a-z]+$/.test(ref) ? `/${ref}` : undefined
		parts.push(href ? { href, text: ref } : ref)
		let call = job ? items.findLast((it) => it.key === job) : undefined
		let head = call?.type === 'tool' ? toolDetails.headline(call.name, call.input) : undefined
		let about = !href ? undefined : head ? head.text.slice(head.mark ? head.mark.length + 1 : 0) : tabs.find((t) => t.id === ref)?.name
		if (about) parts.push(` (${about})`)
	})
	return parts
}

export const toolDetails = { fullCommand, value, headline, lines, unsafe, limit, readOnly, harmless, waiting }
