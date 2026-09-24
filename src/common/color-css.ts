// Browser and terminal share colors.ason. The web server emits validated CSS
// rather than exposing the editable palette as an executable stylesheet.
import { ason } from '../utils/ason.ts'

const READ_ALIASES = ['grep', 'glob', 'ls']
const ROLES: Record<string, string[]> = {
	assistant: ['fg', 'bg', 'bold', 'code', 'linkFg', 'linkBg', 'cursor', 'cursorIdle'],
	thinking: ['fg', 'bg', 'bold', 'code', 'linkBg'],
	user: ['fg', 'bg'], input: ['bg', 'cursor'], log: ['fg', 'code', 'linkBg'],
	info: ['fg', 'bg', 'code', 'linkBg'], warning: ['fg', 'bg', 'code', 'linkBg'],
	error: ['fg', 'bg', 'code', 'linkBg'], fork: ['fg', 'bg'],
	status: ['fg', 'highlight'], tab: ['activeFg', 'inactiveFg', 'doneFg', 'warningFg', 'errorFg', 'pausedFg'],
	help: ['key', 'description'],
}

function color(triple: unknown, vars: Record<string, unknown>): string {
	if (!Array.isArray(triple) || triple.length !== 3) return ''
	const values: number[] = []
	for (const part of triple) {
		const value = typeof part === 'string' && part.startsWith('$') ? vars[part.slice(1)] : part
		if (typeof value !== 'number' || !Number.isFinite(value)) return ''
		values.push(value)
	}
	return `oklch(${values.join(' ')})`
}

function css(source: string): string {
	let raw: Record<string, any>
	try {
		const parsed = ason.parse(source)
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
		raw = parsed as Record<string, any>
	} catch {
		return ''
	}
	const vars: Record<string, unknown> = raw.vars && typeof raw.vars === 'object' ? raw.vars : {}
	const declarations: string[] = []
	for (const [role, fields] of Object.entries(ROLES)) {
		for (const field of fields) {
			const value = color(raw[role]?.[field], vars)
			if (value) declarations.push(`\t--${role}-${field}: ${value};`)
		}
	}
	const rules: string[] = []
	if (declarations.length) rules.push(`:root {\n${declarations.join('\n')}\n}`)
	for (const [name, def] of Object.entries(raw.tools ?? {})) {
		// ASON is editable, but selectors served as CSS must never come from unchecked keys.
		if (name !== 'default' && !/^[a-z][a-z0-9_-]*$/.test(name)) continue
		const block = def as Record<string, unknown>
		const fg = color(block?.fg, vars)
		const bg = color(block?.bg, vars)
		if (!fg || !bg) continue
		const selectors = name === 'default' ? ['.ToolCard'] : [`.ToolCard-${name}`]
		if (name === 'read') for (const alias of READ_ALIASES) selectors.push(`.ToolCard-${alias}`)
		for (const selector of selectors) rules.push(`${selector} {\n\t--tool-fg: ${fg};\n\t--tool-bg: ${bg};\n}`)
	}
	return rules.join('\n')
}

export const colorCss = { css }
