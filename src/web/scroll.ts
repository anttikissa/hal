/// <reference lib="dom" />
// One pinned bottom: changes keep it at the bottom without animation.
// Navigation away releases following; layout clamps do not. History,
// viewport and tab changes preserve reading anchors. Tasks: 4s, 981.
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
	scroll.state.intent = undefined
	scroll.state.held = undefined
}

// The card a block link opened (task 0z) stays where it was put while
// content above it grows, as images load, until the reader moves the
// view: the transcript turns off the browser's scroll anchoring.
function hold(card: Element): void {
	scroll.state.held = { card, top: card.getBoundingClientRect().top }
}

// Puts the held card back in place; whether a card is held.
function keep(): boolean {
	let st = scroll.state, held = st.held, el = st.el
	if (!held || !el) return false
	if (!held.card.isConnected) {
		st.held = undefined
		return false
	}
	let drift = held.card.getBoundingClientRect().top - held.top
	if (Math.abs(drift) >= 1) scroll.put(el, el.scrollTop + drift)
	return true
}

function intent(event?: Event): void {
	let el = scroll.state.el
	if (el) { scroll.state.intent = true; if (!event) scroll.state.top = el.scrollTop }
	if (event) scroll.onTrace(event.type === 'pointerdown' ? 'press' : event.type === 'keydown' ? 'key' : event.type)
}

function navigate(): void {
	let st = scroll.state, el = st.el
	if (!el) return
	// Layout can clamp the old position; only movement beyond that is navigation.
	if (st.intent && Math.abs(el.scrollTop - Math.min(st.top, scroll.target(el, 0))) > atBottom) {
		st.pinned = scroll.gap(el) <= atBottom
		st.held = undefined
		scroll.onTrace(st.pinned ? 'resume' : 'drag')
	}
	st.top = el.scrollTop
}

function onKey(e: KeyboardEvent): void {
	let t = e.target as Element | null
	let find = e.key === 'F3' || ((e.metaKey || e.ctrlKey) && /^[fg]$/i.test(e.key))
	if (!e.defaultPrevented && (find || ((scrollKeys.has(e.key) || e.key === 'Tab') && !t?.closest?.('textarea, input')))) intent(e)
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
	st.top = st.el.scrollTop
	st.reanchor()
}

// Runs after anything that may have moved the view or grown the
// content: a scroll event, a DOM change, the tab shown again. `why`
// names the trigger for diagnostics.
function check(why: string): void {
	let st = scroll.state, el = st.el
	if (!el) return
	navigate()
	if (!st.pinned) { scroll.keep(); return }
	let g = scroll.gap(el)
	if (g <= atBottom) return
	scroll.onTrace(why, g)
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
	if (!scroll.keep()) scroll.put(el, Math.max(0, el.scrollHeight - below))
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
	scroll.state.top = el.scrollTop
	let { stop: stopReflow, capture } = reflow.watch(el, () => {
		navigate()
		if (scroll.state.pinned) { scroll.put(el, scroll.target(el, 0)); return true }
		if (scroll.keep()) return true
		scroll.state.intent = undefined
		return false
	})
	scroll.state.reanchor = capture
	let scrolled = () => {
		scroll.check('scroll')
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
	let wheel = (e: WheelEvent) => { if (!e.ctrlKey && e.deltaY) intent(e) }
	el.addEventListener('pointerdown', intent, { passive: true })
	el.addEventListener('touchstart', intent, { passive: true })
	el.addEventListener('wheel', wheel, { passive: true })
	addEventListener('keydown', onKey)
	return () => {
		scroll.state.el = null
		scroll.state.reanchor = () => {}
		stopReflow()
		el.removeEventListener('scroll', scrolled)
		content.disconnect()
		cards.disconnect()
		document.removeEventListener('visibilitychange', shown)
		el.removeEventListener('pointerdown', intent)
		el.removeEventListener('touchstart', intent)
		el.removeEventListener('wheel', wheel)
		removeEventListener('keydown', onKey)
	}
}

// Runs `change`, which must leave the DOM updated (flush() in Solid),
// and keeps a bottom reader at the bottom.
function follow(change: () => void, force = false): void {
	let st = scroll.state
	navigate()
	if (force) { st.pinned = true; st.held = undefined; st.intent = undefined; scroll.onTrace('force') }
	change()
	scroll.check('content')
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
	scroll.state.held = undefined
	scroll.state.intent = undefined
	let place = scroll.state.places.get(id) ?? { gap: 0 }
	// A tab never shown here opens pinned at the bottom.
	scroll.state.pinned = 'gap' in place && place.gap <= atBottom
	scroll.put(el, 'top' in place ? place.top : scroll.target(el, place.gap))
	scroll.onTrace('restore')
}

export const scroll = {
	// Further above the bottom than this shows the scroll-to-bottom pill.
	awayPx: 200,
	nearTop: 800,
	// `reanchor`: takes reflow's reading anchor at the current view.
	// `held`: the card hold() keeps in place, at `top` in the viewport.
	state: { el: null as Box | null, top: 0, intent: undefined as true | undefined, reanchor: (): void => {}, quiet: false, pinned: true, held: undefined as { card: Element; top: number } | undefined, places: new Map<string, { top: number } | { gap: number }>() },
	onTrace: (_why: string, _pull?: number): void => {},
	gap,
	leave,
	hold,
	keep,
	put,
	moved,
	check,
	target,
	intent,
	atTop,
	anchor,
	quiet,
	init,
	follow,
	save,
	restore,
}
