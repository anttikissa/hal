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

// The description, else the tool's name and its first text argument;
// `key` names the argument shown.
function headline(name: string, input: Record<string, unknown>): { text: string; key?: string } {
	if (typeof input.description === 'string' && oneLine(input.description)) return { text: oneLine(input.description), key: 'description' }
	let first = Object.entries(input).find(([, v]) => typeof v === 'string' && oneLine(v))
	return first ? { text: `${name}: ${oneLine(first[1] as string)}`, key: first[0] } : { text: name }
}

function lines(name: string, input: Record<string, unknown>): string[] {
	let out: string[] = []
	let shown = new Set<string>()
	let head = headline(name, input)
	// The open head wraps, so a one-line headline argument is not repeated.
	if (head.key && !String(input[head.key]).includes('\n')) shown.add(head.key)
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
