import { clipVisual } from '../utils/strings.ts'

const state = {
	hints: [] as string[],
}

function set(hints: string[]): void {
	state.hints = hints
}

function clear(): void {
	state.hints = []
}

function text(maxWidth: number): string {
	if (state.hints.length === 0) return ''
	return clipVisual(state.hints.join('  '), maxWidth)
}

export const completionHints = {
	state,
	set,
	clear,
	text,
}
