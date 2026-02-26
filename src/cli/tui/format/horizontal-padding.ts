import { wordWrapLines } from '../../tui-text.ts'

export interface HorizontalPadding {
	left: number
	right: number
}

function safePadding(padding: HorizontalPadding): HorizontalPadding {
	return {
		left: Math.max(0, Math.floor(Number.isFinite(padding.left) ? padding.left : 0)),
		right: Math.max(0, Math.floor(Number.isFinite(padding.right) ? padding.right : 0)),
	}
}

export function contentWidthWithPadding(cols: number, padding: HorizontalPadding): number {
	if (cols <= 0) return 1
	const safe = safePadding(padding)
	return Math.max(1, cols - safe.left - safe.right)
}

export function wrapPlainTextWithPadding(
	text: string,
	cols: number,
	padding: HorizontalPadding,
): string[] {
	const safe = safePadding(padding)
	const width = contentWidthWithPadding(cols, safe)
	const left = ' '.repeat(safe.left)
	const right = ' '.repeat(safe.right)
	return wordWrapLines(text, width).map((line) => `${left}${line}${right}`)
}
