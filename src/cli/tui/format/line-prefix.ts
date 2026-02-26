import { getStyle } from '../../format/theme.ts'

const RESET = '\x1b[0m'
const PREFIX_RE = /^(\[[^\]]+\]\s*)/

export function styleLinePrefix(kind: string, text: string): string {
	const m = text.match(PREFIX_RE)
	if (!m) return text
	const prefix = m[1]
	const rest = text.slice(prefix.length)
	const style = getStyle(kind)
	if (!style) return text
	return `${style}${prefix}${RESET}${style}${rest}`
}
