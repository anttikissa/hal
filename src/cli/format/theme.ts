import { readFileSync } from 'fs'
import { parse } from '../../utils/ason.ts'

/** Map from style token → ANSI escape sequence */
const STYLES: Record<string, string> = {
	'': '',
	dim: '\x1b[2m',
	bold: '\x1b[1m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	magenta: '\x1b[35m',
	cyan: '\x1b[36m',
	white: '\x1b[37m',
	// 256-color backgrounds: bg0–bg255
	// 256-color foregrounds: fg0–fg255
}

function resolveStyle(token: string): string {
	if (!token) return ''
	if (STYLES[token] !== undefined) return STYLES[token]

	// Compound styles: "bold dim", "bold red", etc.
	if (token.includes(' ')) {
		return token.split(' ').map(resolveStyle).join('')
	}

	// 256-color: bg0–bg255, fg0–fg255
	const bgMatch = token.match(/^bg(\d+)$/)
	if (bgMatch) return `\x1b[48;5;${bgMatch[1]}m`
	const fgMatch = token.match(/^fg(\d+)$/)
	if (fgMatch) return `\x1b[38;5;${fgMatch[1]}m`

	// RGB: rgb(r,g,b) for foreground, bgrgb(r,g,b) for background
	const rgbMatch = token.match(/^rgb\((\d+),(\d+),(\d+)\)$/)
	if (rgbMatch) return `\x1b[38;2;${rgbMatch[1]};${rgbMatch[2]};${rgbMatch[3]}m`
	const bgRgbMatch = token.match(/^bgrgb\((\d+),(\d+),(\d+)\)$/)
	if (bgRgbMatch) return `\x1b[48;2;${bgRgbMatch[1]};${bgRgbMatch[2]};${bgRgbMatch[3]}m`

	// Raw ANSI escape passthrough
	if (token.startsWith('\x1b[')) return token

	return ''
}

export interface Theme {
	styles: Record<string, string>
}

export function loadTheme(halDir: string, themeName: string): Theme {
	const path = `${halDir}/themes/${themeName}.ason`
	const raw = readFileSync(path, 'utf8')
	const data = parse(raw) as Record<string, string>
	const styles: Record<string, string> = {}
	for (const [key, token] of Object.entries(data)) {
		styles[key] = resolveStyle(token)
	}
	return { styles }
}

// Active theme — loaded once at startup, reloadable via loadActiveTheme()
let activeTheme: Theme = { styles: {} }

export function loadActiveTheme(halDir: string, themeName: string): void {
	activeTheme = loadTheme(halDir, themeName)
}

export function getStyle(key: string): string {
	return activeTheme.styles[key] ?? ''
}
