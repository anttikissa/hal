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

/** Keep a UTF-8 string within a byte budget, preserving the suffix inside the limit. */
function truncateUtf8(text: string, limit: number, suffix: string): string {
	if (Buffer.byteLength(text, 'utf8') <= limit) return text

	const suffixBytes = Buffer.byteLength(suffix, 'utf8')
	const budget = limit - suffixBytes
	if (budget <= 0) return suffix.slice(0, limit)

	let lo = 0
	let hi = text.length
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2)
		if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= budget) lo = mid
		else hi = mid - 1
	}
	return text.slice(0, lo) + suffix
}

/** "1 file", "3 files", "0 files" — English-only, good enough for a CLI. */
function pluralize(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Debounce: call fn at most once per `ms` milliseconds.
 *  Trailing-edge: the last call in a burst wins. */
function debounce<Args extends unknown[]>(fn: (...args: Args) => void, ms: number): (...args: Args) => void {
	let timer: ReturnType<typeof setTimeout> | null = null
	return (...args: Args) => {
		if (timer) clearTimeout(timer)
		timer = setTimeout(() => {
			timer = null
			fn(...args)
		}, ms)
	}
}

export const helpers = { truncateMiddle, truncateUtf8, pluralize, debounce }
