// Complete model-supplied arguments, in readable text rather than wire syntax.
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

function lines(name: string, id: string, input: Record<string, unknown>): string[] {
	let out = [`Tool: ${name}`, `Call ID: ${id}`, '', 'Arguments supplied by the model:']
	if (!Object.keys(input).length) out.push('  (none)')
	for (let [key, v] of Object.entries(input)) {
		let label = key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ')
		let type = v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v === 'string' ? 'text' : typeof v
		out.push(`  ${label} (${key}) — ${type}:`, ...toolDetails.value(v).map((l) => `    ${l}`))
	}
	if (name === 'bash') {
		let missing: string[] = []
		if (!Object.hasOwn(input, 'command')) missing.push('Command: not supplied (required)')
		if (!Object.hasOwn(input, 'description')) missing.push('Description: not supplied (required)')
		if (!Object.hasOwn(input, 'modifies')) missing.push('Modifies: not supplied; no declared files')
		if (!Object.hasOwn(input, 'background')) missing.push('Background: not supplied; default false (foreground)')
		if (!Object.hasOwn(input, 'timeout')) missing.push(`Timeout: not supplied; default ${input.background === true ? '600000 ms (background)' : '120000 ms (foreground)'}`)
		if (missing.length) out.push('', 'Omitted arguments and defaults:', ...missing.map((l) => `  ${l}`))
		let timeout = Number(input.timeout) > 0 ? Number(input.timeout) : input.background === true ? 600_000 : 120_000
		out.push('', 'Execution controls (if validation succeeds):', `  Mode: ${input.background === true ? 'background' : 'foreground'}`, `  Timeout: ${timeout} ms${Number(input.timeout) > 0 ? ' (from supplied value)' : ' (default)'}`)
	}
	return out
}

export const toolDetails = { value, lines }
