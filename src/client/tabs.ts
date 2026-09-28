// Which tab this terminal shows (tasks/7w): the host keeps the tabs,
// every client its own focus. Pure: the rules as a function of the tab
// list before and after a change, the focus, and the tab this client
// asked for (the one its own tab command created, reopened or picked).

// `opener`: the focused tab was created or reopened here from `from`;
// closing it goes back there. It lasts only while focus stays on it.
export type Focus = { tab?: string; opener?: { tab: string; from: string } }

// The focus after the tabs went from `old` to `next`. `asked` wins once
// it is a tab; tabs other clients open, move or close never move focus,
// unless they close the focused tab.
function focus(old: string[], next: string[], current: Focus, asked?: string): Focus {
	let { tab, opener } = current
	if (asked !== undefined && next.includes(asked)) {
		if (asked === tab) return current
		return tab === undefined ? { tab: asked } : { tab: asked, opener: { tab: asked, from: tab } }
	}
	if (tab === undefined || next.includes(tab)) return current
	if (opener?.tab === tab && next.includes(opener.from)) return { tab: opener.from }
	// Closed: its right neighbour, else the new last tab.
	let right = old.slice(old.indexOf(tab) + 1).find((id) => next.includes(id))
	let to = right ?? next.at(-1)
	return to === undefined ? {} : { tab: to }
}

// The tab `step` places from `tab` (Ctrl-N 1, Ctrl-P -1), wrapping.
function step(ids: string[], tab: string | undefined, by: number): string | undefined {
	if (!ids.length) return undefined
	let i = tab === undefined ? -1 : ids.indexOf(tab)
	if (i < 0) return ids[0]
	return ids[(((i + by) % ids.length) + ids.length) % ids.length]
}

type TabKey = { key: string; shift: boolean; alt: boolean; ctrl: boolean; cmd: boolean }

// The tab a tab key focuses from tab `tab` among `ids`: next, previous,
// go to 1-10. Undefined if `k` is no tab key. New, reopen and close are
// commands (client/commands/).
function key(k: TabKey, tab: { id: string }, ids: string[]): { focus?: string } | undefined {
	if (k.cmd) return undefined
	if (k.ctrl && !k.alt && !k.shift && (k.key === 'n' || k.key === 'p')) return { focus: tabs.step(ids, tab.id, k.key === 'n' ? 1 : -1) }
	if (k.alt && !k.ctrl && !k.shift && /^[0-9]$/.test(k.key)) return { focus: ids[(Number(k.key) + 9) % 10] }
	return undefined
}

export const tabs = { focus, step, key }
