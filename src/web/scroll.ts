/// <reference lib="dom" />
// One pinned bottom: changes keep it at the bottom without animation.
// Reader input leaves following; history and viewport changes preserve
// reading anchors, and each tab keeps its position. Tasks: 4s, e5h.
import { reflow } from './reflow.ts'

type Box = { scrollHeight: number; scrollTop: number; clientHeight: number }

// How far the view is above the bottom.
function gap(el: Box): number {
	return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
}

// Where the view goes to be `gap` above the bottom.
function target(el: Box, gap: number): number {
	return Math.max(0, el.scrollHeight - el.clientHeight - gap)
}

const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

// At most this far above the bottom still counts as at the bottom:
// scroll positions can be fractional.
const atBottom = 1

function leave(): void {
	scroll.state.pinned = false
}

// A new finger gesture is deliberate, unlike leftover wheel momentum.
// Streaming must not fight it while the finger is dragging away from
// the bottom, even before the gap has crossed the follow threshold.
function touchStart(): void {
	scroll.state.touching = true
	scroll.leave()
}

function touchEnd(): void {
	scroll.state.touching = false
	scroll.check('touchend')
}

function onKey(e: KeyboardEvent): void {
	let t = e.target as Element | null
	// Find in page jumps to a match, from any field.
	let find = e.key === 'F3' || ((e.metaKey || e.ctrlKey) && /^[fg]$/i.test(e.key))
	if (find) return scroll.leave()
	// Tab may focus a card off screen, and the browser scrolls it into view.
	if ((scrollKeys.has(e.key) || e.key === 'Tab') && !t?.closest?.('textarea, input')) scroll.leave()
}

// Sets the view's position and remembers it as ours, so the scroll
// event it causes is not mistaken for the reader dragging.
function put(el: Box, top: number): void {
	el.scrollTop = top
	scroll.moved()
}

// The view moved by our hand (put, a linked card scrolled into view):
// remember the position as ours and read from here. A resize seen
// before the scroll event would otherwise restore the reading anchor
// from before the move (task 0z).
function moved(): void {
	let st = scroll.state
	if (!st.el) return
	st.set = st.el.scrollTop
	st.reanchor()
}

// Runs after anything that may have moved the view or grown the
// content: a scroll event, a DOM change, the tab shown again. `why`
// names the trigger for diagnostics (onPull).
function check(why: string, scrolled = false): void {
	let st = scroll.state, el = st.el
	if (!el) return
	// A move we did not make, while a mouse button or finger is down,
	// is the reader dragging: selecting past the edge, middle-button
	// autoscroll, or the scrollbar thumb.
	if (scrolled && (st.pressing || st.touching) && Math.abs(el.scrollTop - st.set) > 2) scroll.leave()
	let g = scroll.gap(el)
	// At the very bottom, however it got there: pinned again. Not while
	// a finger is down, since the drag may be heading up.
	if (g <= atBottom) {
		if (!st.touching) st.pinned = true
		return
	}
	// Pinned but above the bottom:
	// something other than the reader moved the view or grew the
	// content. Pull back, unless a press is under way (a click or the
	// start of a selection must not have the text slide under it).
	if (!st.pinned || st.pressing || st.touching) return
	scroll.onPull(g, why)
	scroll.put(el, scroll.target(el, 0))
}

// Whether the reader is within `nearTop` px of the top, where earlier
// history is fetched (common/backfill.ts).
function atTop(): boolean {
	let el = scroll.state.el
	return !!el && el.scrollTop < scroll.nearTop
}

// Runs `change`, which puts earlier history above what is shown and
// leaves the DOM updated, keeping what the reader was reading in place:
// the same distance from the bottom, since only the top grew.
function anchor(change: () => void): void {
	let el = scroll.state.el
	if (!el) return change()
	let below = el.scrollHeight - el.scrollTop
	scroll.quiet(change)
	scroll.put(el, Math.max(0, el.scrollHeight - below))
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

// Follow `el`; returns the cleanup. `onTop`: the reader scrolled near
// the top.
function init(el: HTMLElement, onTop: () => void = () => {}): () => void {
	scroll.state.el = el
	let { stop: stopReflow, capture } = reflow.watch(el, () => {
		if (scroll.state.touching || scroll.state.pressing) return true
		// Pinned: the bottom is the anchor, whatever the reading anchor says.
		if (scroll.state.pinned) {
			scroll.put(el, scroll.target(el, 0))
			return true
		}
		return false
	})
	scroll.state.reanchor = capture
	let scrolled = () => {
		scroll.check('scroll', true)
		if (scroll.atTop()) onTop()
	}
	el.addEventListener('scroll', scrolled, { passive: true })
	// Streamed text and new cards change the DOM; a change that no
	// follow() covered would otherwise leave a pinned view short.
	let content = new MutationObserver((changes) => { if (changes.some((c) => c.target === el && c.type === 'childList')) watchCards(); scroll.check('content') })
	content.observe(el, { childList: true, characterData: true, subtree: true })
	// A card can also grow with no DOM change and no scroll event: its
	// open animation, an image or font arriving. Watch each card's size,
	// so that growth too keeps the bottom. Unobserve removed cards so
	// switching sessions does not retain their DOM.
	let cards = new ResizeObserver(() => scroll.check('resize'))
	let watched = new Set<Element>()
	let watchCards = () => {
		for (let c of watched) if (c.parentElement !== el) { cards.unobserve(c); watched.delete(c) }
		for (let c of el.children) if (!watched.has(c)) { cards.observe(c, { box: 'border-box' }); watched.add(c) }
	}
	watchCards()
	// Catch up after the browser suspends a background tab.
	let shown = () => { if (!document.hidden) scroll.check('shown') }
	document.addEventListener('visibilitychange', shown)
	// A press inside the transcript; on the scrollbar (right of the
	// content box) it is the reader taking the view.
	let press = (e: PointerEvent) => {
		scroll.state.pressing = true
		if (e.target === el && e.offsetX >= el.clientWidth) scroll.leave()
	}
	let release = () => { scroll.state.pressing = false; scroll.check('release') }
	el.addEventListener('pointerdown', press, { passive: true })
	addEventListener('pointerup', release, { passive: true })
	addEventListener('pointercancel', release, { passive: true })
	addEventListener('wheel', scroll.leave, { passive: true })
	el.addEventListener('touchstart', scroll.touchStart, { passive: true })
	el.addEventListener('touchend', scroll.touchEnd, { passive: true })
	el.addEventListener('touchcancel', scroll.touchEnd, { passive: true })
	addEventListener('keydown', scroll.onKey)
	return () => {
		scroll.state.el = null
		scroll.state.reanchor = () => {}
		stopReflow()
		el.removeEventListener('scroll', scrolled)
		content.disconnect()
		cards.disconnect()
		document.removeEventListener('visibilitychange', shown)
		el.removeEventListener('pointerdown', press)
		removeEventListener('pointerup', release)
		removeEventListener('pointercancel', release)
		scroll.state.pressing = false
		removeEventListener('wheel', scroll.leave)
		el.removeEventListener('touchstart', scroll.touchStart)
		el.removeEventListener('touchend', scroll.touchEnd)
		el.removeEventListener('touchcancel', scroll.touchEnd)
		scroll.state.touching = false
		removeEventListener('keydown', scroll.onKey)
	}
}

// Runs `change`, which must leave the DOM updated (flush() in Solid),
// and keeps a bottom reader at the bottom.
function follow(change: () => void, force = false): void {
	let st = scroll.state
	if (force) st.pinned = true
	change()
	if (st.el && st.pinned && (force || (!st.touching && !st.pressing))) scroll.put(st.el, scroll.target(st.el, 0))
}

// Each tab keeps its place: a pinned reader returns to the bottom
// (it may have grown), an unpinned reader returns
// to the same spot; a tab never shown here opens at the bottom.
function save(id: string): void {
	let el = scroll.state.el
	if (!el) return
	// A pinned reader comes back pinned, even if a drift was not yet
	// pulled back.
	scroll.state.places.set(id, scroll.state.pinned ? { gap: 0 } : { top: el.scrollTop })
}

function restore(id: string): void {
	let el = scroll.state.el
	if (!el) return
	let place = scroll.state.places.get(id) ?? { gap: 0 }
	// A tab never shown here opens pinned at the bottom.
	scroll.state.pinned = 'gap' in place && place.gap <= atBottom
	scroll.put(el, 'top' in place ? place.top : scroll.target(el, place.gap))
}

export const scroll = {
	// Further above the bottom than this shows the scroll-to-bottom pill.
	awayPx: 200,
	nearTop: 800,
	// `pinned`: see the header. `pressing`: a mouse button or pen is down
	// in the transcript. `set`: the last position this module set.
	// `reanchor`: takes reflow's reading anchor at the current view.
	state: { el: null as Box | null, reanchor: (): void => {}, quiet: false, set: 0, touching: false, pinned: true, pressing: false, places: new Map<string, { top: number } | { gap: number }>() },
	// Called when a pinned view is pulled back to the bottom, with the
	// gap found and the trigger. A diagnostics hook (drift.ts); no-op.
	onPull: (_gap: number, _why: string): void => {},
	gap,
	leave,
	put,
	moved,
	check,
	target,
	touchStart,
	touchEnd,
	onKey,
	atTop,
	anchor,
	quiet,
	init,
	follow,
	save,
	restore,
}
