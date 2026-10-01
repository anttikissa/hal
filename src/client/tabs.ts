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

export const tabs = { focus }
