const RESET = '\x1b[0m'

export function applyStylePerLine(style: string, text: string): string {
	if (!style) return text
	return text.split('\n').map((line) => `${style}${line}${RESET}`).join('\n')
}
