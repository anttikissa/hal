import { wordWrapLines } from './tui-text.ts'

export interface WrappedInputLayout {
	lines: string[]
	starts: number[]
}

export function getWrappedInputLayout(input: string, width: number): WrappedInputLayout {
	const lines = wordWrapLines(input, width)
	const starts: number[] = []
	let charsSoFar = 0

	for (let i = 0; i < lines.length; i++) {
		const lineLen = lines[i].length
		starts.push(charsSoFar)
		const breakChar =
			i < lines.length - 1 && charsSoFar + lineLen < input.length ? input[charsSoFar + lineLen] : ''
		const consumed = lineLen + (breakChar === ' ' || breakChar === '\n' ? 1 : 0)
		charsSoFar += consumed
	}

	return { lines, starts }
}

export function cursorToWrappedRowCol(
	input: string,
	absPos: number,
	width: number,
): { row: number; col: number } {
	const { lines, starts } = getWrappedInputLayout(input, width)

	for (let i = 0; i < lines.length; i++) {
		const lineLen = lines[i].length
		if (absPos <= starts[i] + lineLen) {
			return { row: i, col: absPos - starts[i] }
		}
	}

	const lastLine = lines.length - 1
	return { row: lastLine, col: lines[lastLine]?.length ?? 0 }
}

export function wrappedRowColToCursor(
	input: string,
	row: number,
	col: number,
	width: number,
): number {
	const { lines, starts } = getWrappedInputLayout(input, width)
	if (lines.length === 0) return 0
	const clampedRow = Math.max(0, Math.min(row, lines.length - 1))
	const lineLen = lines[clampedRow]?.length ?? 0
	return starts[clampedRow] + Math.max(0, Math.min(col, lineLen))
}

export interface VerticalMoveResult {
	cursor: number
	goalCol: number
	atBoundary: boolean
}

export function verticalMove(
	input: string,
	width: number,
	currentCursor: number,
	goalCol: number | null,
	direction: -1 | 1,
): VerticalMoveResult {
	const { lines } = getWrappedInputLayout(input, width)
	const { row, col } = cursorToWrappedRowCol(input, currentCursor, width)
	const effectiveGoalCol = goalCol ?? col

	const targetRow = row + direction
	if (targetRow < 0 || targetRow >= lines.length) {
		return { cursor: currentCursor, goalCol: effectiveGoalCol, atBoundary: true }
	}

	const newCursor = wrappedRowColToCursor(input, targetRow, effectiveGoalCol, width)
	return { cursor: newCursor, goalCol: effectiveGoalCol, atBoundary: false }
}
