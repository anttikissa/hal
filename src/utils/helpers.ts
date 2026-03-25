// Small general-purpose utilities that don't warrant their own file.

/** Truncate string in the middle, keeping start and end visible.
 *  "hello world this is long" → "hello w…is long" */
function truncateMiddle(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text
	if (maxLen <= 1) return '…'
	// Split budget: slightly more to the start for readability
	const endLen = Math.floor((maxLen - 1) / 2)
	const startLen = maxLen - 1 - endLen
	return text.slice(0, startLen) + '…' + text.slice(-endLen)
}

/** "1 file", "3 files", "0 files" — English-only, good enough for a CLI. */
function pluralize(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Debounce: call fn at most once per `ms` milliseconds.
 *  Trailing-edge: the last call in a burst wins. */
function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
	let timer: ReturnType<typeof setTimeout> | null = null
	return ((...args: any[]) => {
		if (timer) clearTimeout(timer)
		timer = setTimeout(() => {
			timer = null
			fn(...args)
		}, ms)
	}) as unknown as T
}

export const helpers = { truncateMiddle, pluralize, debounce }
