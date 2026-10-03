// A tool call in readable text, relevant parts once (AGENTS.md "UI:
// visible plumbing", task 8t): a headline for the card's head, and the
// lines an open card adds without repeating it. Bash reads like the
// terminal; call IDs, argument types and defaults stay in session files.

// A value in readable text rather than wire syntax.
function value(input: unknown, indent = ''): string[] {
	if (typeof input === 'string') return input === '' ? ['(empty string)'] : input.split('\n')
	if (input === null) return ['(null)']
	if (Array.isArray(input)) return input.length ? input.flatMap((v, i) => {
		let lines = value(v, indent + '  ')
		return [`${indent}${i + 1}. ${lines[0]}`, ...lines.slice(1).map((l) => `${indent}   ${l}`)]
	}) : ['(empty list)']
	if (typeof input === 'object') return Object.entries(input).length ? Object.entries(input).flatMap(([key, v]) => [
		`${indent}${key}:`, ...value(v, indent + '  ').map((l) => `  ${l}`),
	]) : ['(empty object)']
	return [String(input)]
}

let oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

// A card's title: what the call does, in words (task jz). Each tool
// reads as a verb and its object: Google for "words", Read <path or
// URL>, Inspect project (tab, id), Spawn "name" (tab 3, 31-swe),
// Wait for 31-swe, 31-bux. Bash shows the model's description, marked
// (background) when backgrounded; its command opens below. A
// model-run slash command reads as typed, "/rename …" (task 9g).
// `output`: the call's result, when known, adds what only the host
// knew (the tab and id spawn opened, whom wait waits for). `key` and
// `keys` name the arguments shown, which lines() then leaves out.
function headline(name: string, input: Record<string, unknown>, output?: string): { text: string; key?: string; keys?: string[] } {
	let str = (k: string) => (typeof input[k] === 'string' && oneLine(input[k] as string)) || undefined
	// [tab, id] of each session the result names (tabs.label).
	let ids = (re: RegExp) => [...(output ?? '').matchAll(re)].map((m) => [m[1], m[2]!] as const)
	switch (name) {
		case 'bash': {
			let text = (str('description') ?? oneLine(String(input.command ?? '').split('\n')[0]!)) || 'bash'
			return { text: input.background === true ? `${text} (background)` : text, key: str('description') ? 'description' : undefined }
		}
		case 'command':
			if (str('command')) return { text: str('command')!, key: 'command' }
			break
		case 'google':
			if (str('query')) return { text: `Google for "${str('query')}"`, key: 'query' }
			break
		case 'read':
		case 'read_url':
		case 'read_blob': {
			let key = name === 'read' ? 'path' : name === 'read_url' ? 'url' : 'id'
			if (str(key)) return { text: `Read ${str(key)}`, key }
			break
		}
		case 'notify':
			if (str('text')) return { text: `Notify "${str('text')}"`, key: 'text' }
			break
		case 'inspect': {
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
		case 'wait': {
			if (output?.startsWith('No subagent')) return { text: 'Wait (no subagent running)' }
			let who = ids(/(?:^Waiting for |, )(?:tab (\d+) · )?(\d+-[a-z]+)/g).map(([, id]) => id)
			return { text: `Wait for ${who.length ? who.join(', ') : 'subagents'}` }
		}
	}
	if (str('description')) return { text: str('description')!, key: 'description' }
	let first = Object.entries(input).find(([, v]) => typeof v === 'string' && oneLine(v))
	let verb = name.charAt(0).toUpperCase() + name.slice(1)
	return first ? { text: `${verb} ${oneLine(first[1] as string)}`, key: first[0] } : { text: verb }
}

function lines(name: string, input: Record<string, unknown>): string[] {
	let out: string[] = []
	let shown = new Set<string>()
	let head = headline(name, input)
	// The open head wraps, so a one-line headline argument is not repeated.
	if (head.key && !String(input[head.key]).includes('\n')) shown.add(head.key)
	for (let k of head.keys ?? []) shown.add(k)
	if (name === 'bash') {
		let { command, modifies, background, timeout } = input
		if (typeof command === 'string') {
			let [first, ...rest] = command.split('\n')
			out.push(`${background === true ? '&' : '$'} ${first}`, ...rest.map((l) => `  ${l}`))
			shown.add('command').add('description')
		}
		let files = typeof modifies === 'string' ? [modifies] : Array.isArray(modifies) && modifies.every((f) => typeof f === 'string') ? modifies : undefined
		if (files) {
			if (files.length) out.push(`Edits ${files.join(', ')}`)
			shown.add('modifies')
		}
		if (typeof background === 'boolean') shown.add('background')
		if (typeof timeout === 'number') {
			if (timeout !== (background === true ? 600_000 : 120_000)) out.push(`Timeout ${timeout / 1000} s`)
			shown.add('timeout')
		}
	}
	for (let [key, v] of Object.entries(input)) {
		if (shown.has(key)) continue
		let [first, ...rest] = value(v)
		out.push(`${key}: ${first}`, ...rest.map((l) => `  ${l}`))
	}
	return out
}

export const toolDetails = { value, headline, lines }
