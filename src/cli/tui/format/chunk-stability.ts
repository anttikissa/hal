const RESET = '\x1b[0m'

export function chunkPrefixForStability(kind: string, previousKind: string): string {
	if (kind !== 'chunk.assistant' && kind !== 'chunk.thinking') return ''
	if (kind === previousKind) return ''
	if (previousKind.startsWith('chunk.')) return '\n'
	return RESET
}
