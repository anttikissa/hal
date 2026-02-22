/** Per-kind formatter controlling how a UI element is rendered. */
export interface Formatter {
	/** ANSI style prefix applied to the text (e.g. DIM, BOLD). Empty string = unstyled. */
	style: string
	/** Optional text transform before styling. */
	formatText?: (text: string) => string
	/** Full-width decoration emitted before the content block. Receives terminal cols. */
	blockStart?: (cols: number) => string
	/** Full-width decoration emitted after the content block. Receives terminal cols. */
	blockEnd?: (cols: number) => string
}
