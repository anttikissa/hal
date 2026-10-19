/// <reference lib="dom" />
// A page about to freeze from memory pressure (task mz4): warn while
// the reader can still reload. Chrome only: performance.memory is
// non-standard, coarse (bucketed, refreshed at most every 20 min) and
// counts the JS heap, not DOM nodes. Elsewhere this does nothing. Local:
// nothing is sent.
import { notices } from '../common/notices.ts'

const limit = 1024 ** 3
const used = (): number | undefined =>
	(performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize

function check(): void {
	let bytes = used()
	if (bytes === undefined || bytes < limit) return notices.remove('page-memory')
	notices.add({
		key: 'page-memory',
		kind: 'warning',
		stays: true,
		href: location.pathname + location.search,
		title: `This page uses ${(bytes / limit).toFixed(1)} GB of memory`,
		line: 'Click to reload it before it freezes.',
	})
}

function init(): void {
	if (used() !== undefined) setInterval(check, 60_000)
}

export const memory = { init, used }
