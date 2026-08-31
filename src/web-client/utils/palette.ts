// Tool colors come from colors.ason, the same file the terminal reads, so both
// clients stay one edit away from each other. CSS speaks oklch natively, so the
// triples need no conversion: they become custom properties verbatim and the
// browser does the color math the terminal does in oklch.ts.

import { ason } from '../../utils/ason.ts'

// read-like tools share read's colors in the terminal; mirror that here.
const READ_ALIASES = ['grep', 'glob', 'ls']

type Triple = [number | string, number | string, number | string]

function color(triple: unknown, vars: Record<string, number>): string {
	if (!Array.isArray(triple) || triple.length !== 3) return ''
	const values: number[] = []
	for (const part of triple as Triple) {
		const value = typeof part === 'string' && part.startsWith('$') ? vars[part.slice(1)] : Number(part)
		if (typeof value !== 'number' || !Number.isFinite(value)) return ''
		values.push(value)
	}
	return `oklch(${values.join(' ')})`
}

function rule(selector: string, def: unknown, vars: Record<string, number>): string {
	const block = def && typeof def === 'object' ? def as Record<string, unknown> : {}
	const fg = color(block.fg, vars)
	const bg = color(block.bg, vars)
	if (!fg || !bg) return ''
	return `${selector} {\n\t--tool-fg: ${fg};\n\t--tool-bg: ${bg};\n}`
}

/** Turn colors.ason text into the tool-card custom properties. */
function css(source: string): string {
	let raw: any
	try {
		raw = ason.parse(source)
	} catch {
		return ''
	}
	const vars: Record<string, number> = { ...raw?.vars }
	const tools: Record<string, unknown> = { ...raw?.tools }
	const rules: string[] = []
	for (const [name, def] of Object.entries(tools)) {
		// 'default' styles the base card; every other tool overrides it by name.
		const selectors = name === 'default' ? ['.ToolCard'] : [`.ToolCard-${name}`]
		if (name === 'read') for (const alias of READ_ALIASES) selectors.push(`.ToolCard-${alias}`)
		for (const selector of selectors) {
			const text = rule(selector, def, vars)
			if (text) rules.push(text)
		}
	}
	return rules.join('\n')
}

// The terminal watches colors.ason with fs.watch; a browser cannot, so it polls
// the same file over the route that serves it. Colors are a design surface people
// tweak while looking at the result, so a slow poll beats another socket message.
const config = { pollMs: 2000 }

function fetchSource(): Promise<string> {
	return fetch('/colors.ason', { cache: 'no-store' }).then((response) => response.ok ? response.text() : '')
}

function pause(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, palette.config.pollMs))
}

/** Poll colors.ason and restyle only when its content actually changed. */
async function sync(apply: (css: string) => void, stopped: () => boolean = () => false): Promise<void> {
	let previous: string | null = null
	while (!stopped()) {
		let source = ''
		try {
			source = await palette.fetchSource()
		} catch {
			// The host restarts often; keep the colors we already have.
		}
		if (source !== previous) {
			previous = source
			apply(palette.css(source))
		}
		if (!stopped()) await palette.pause()
	}
}

export const palette = { config, css, fetchSource, pause, sync }
