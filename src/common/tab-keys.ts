// The tab-switching keys both clients share: Ctrl-N next, Ctrl-P
// previous, Alt-1..9 tab 1-9 and Alt-0 the tenth. Opening, reopening
// and closing tabs are commands with keys (common/commands/list.ts).

import type { Binding } from './key-help.ts'

// The tab `by` places from `tab` among `ids`, wrapping.
function step(ids: string[], tab: string | undefined, by: number): string | undefined {
	if (!ids.length) return undefined
	let i = tab === undefined ? -1 : ids.indexOf(tab)
	if (i < 0) return ids[0]
	return ids[(((i + by) % ids.length) + ids.length) % ids.length]
}

// The tab key `k` focuses from tab `tab` among `ids` (none past the
// last tab), or undefined if `k` is no tab-switching key.
function key(k: Binding, tab: string, ids: string[]): { focus?: string } | undefined {
	if (k.cmd) return undefined
	if (k.ctrl && !k.alt && !k.shift && (k.key === 'n' || k.key === 'p')) return { focus: step(ids, tab, k.key === 'n' ? 1 : -1) }
	if (k.alt && !k.ctrl && !k.shift && /^[0-9]$/.test(k.key)) return { focus: ids[(Number(k.key) + 9) % 10] }
	return undefined
}

export const tabKeys = { step, key }
