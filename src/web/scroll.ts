/// <reference lib="dom" />
// Hal moves the transcript only when the reader acts: sends, taps the
// to-bottom pill, follows a link or returns to a tab. The transcript is
// a column-reverse scroller (index.html): scrollTop is 0 at the bottom
// and negative above it, so the browser keeps a bottom reader there
// through growth and resizes, and its scroll anchoring keeps a reader
// above in place. Task tzg.

type Box = { scrollHeight: number; scrollTop: number; clientHeight: number }

// How far the view is above the bottom.
function gap(el: Box): number {
	return Math.max(0, -el.scrollTop)
}

// Puts the view at the bottom.
function bottom(): void {
	let el = scroll.state.el
	if (el) el.scrollTop = 0
}

// Whether the reader is within `nearTop` px of the top, where earlier
// history is fetched (common/backfill.ts).
function atTop(): boolean {
	let el = scroll.state.el
	return !!el && el.scrollHeight - el.clientHeight - scroll.gap(el) < scroll.nearTop
}

// Runs `change` with new cards appearing at once: a tab's rows, or
// earlier ones above the reader, are not news, so no fade.
function quiet(change: () => void): void {
	scroll.state.quiet = true
	try {
		change()
	} finally {
		scroll.state.quiet = false
	}
}

// Watch `el`; returns the cleanup. `onTop`: the reader scrolled near
// the top.
function init(el: HTMLElement, onTop: () => void): () => void {
	scroll.state.el = el
	let scrolled = () => scroll.atTop() && onTop()
	el.addEventListener('scroll', scrolled, { passive: true })
	return () => {
		scroll.state.el = null
		el.removeEventListener('scroll', scrolled)
	}
}

// Each tab keeps its distance from the bottom; a tab never shown here
// opens at the bottom.
function save(id: string): void {
	let el = scroll.state.el
	if (el) scroll.state.places.set(id, el.scrollTop)
}

function restore(id: string): void {
	let el = scroll.state.el
	if (el) el.scrollTop = scroll.state.places.get(id) ?? 0
}

export const scroll = {
	// Further above the bottom than this shows the to-bottom pill.
	awayPx: 200,
	nearTop: 800,
	state: {
		el: null as Box | null,
		quiet: false,
		// Tab id: its scrollTop, 0 or less.
		places: new Map<string, number>(),
	},
	gap,
	bottom,
	atTop,
	quiet,
	init,
	save,
	restore,
}
