/// <reference lib="dom" />
// Keeps a reader who is at the bottom there while content changes,
// without animation. Following is on or off, and only the reader's own
// scrolling sets it: scrolling up turns it off, reaching the bottom on.
// Nothing else, not momentum nor layout, changes it. History, viewport
// and tab changes keep reading anchors. Tasks: 4s, 981.
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

// At most this far above the bottom still counts as at the bottom:
// scroll positions can be fractional.
const atBottom = 1

// A wheel or key scroll may move the view this long after its event.
const inputMs = 300

// Sets following. Each change is a diagnostic transition (task 981).
function pin(on: boolean, why: string): void {
	let st = scroll.state
	if (st.pinned === on) return
	st.pinned = on
	scroll.onPin(why)
}

// `why`: the reader's action that left the bottom.
function leave(why: string): void {
	pin(false, why)
	scroll.state.held = undefined
}

// Link navigation follows the bottom if it lands there; otherwise hold
// the linked card in place through layout changes until the reader moves.
function hold(card: Element): void {
	let st = scroll.state
	if (!st.el) return
	pin(scroll.gap(st.el) <= atBottom, 'link')
	st.held = st.pinned ? undefined : { card, top: card.getBoundingClientRect().top }
}

// Puts the held card back in place; whether a card is held.
function keep(): boolean {
	let st = scroll.state,
		held = st.held,
		el = st.el
	if (!held || !el) return false
	if (!held.card.isConnected) {
		st.held = undefined
		return false
	}
	let drift = held.card.getBoundingClientRect().top - held.top
	if (Math.abs(drift) >= 1) scroll.put(el, el.scrollTop + drift)
	return true
}

// Whether the reader scrolls now: a finger or mouse button is down, or
// a wheel or key event just came.
function steering(): boolean {
	let st = scroll.state
	return st.finger || performance.now() - st.input < inputMs
}

// The reader's scrolling sets following.
function navigate(): void {
	let st = scroll.state,
		el = st.el
	if (!el || !steering() || el.scrollTop === st.top) return
	let up = el.scrollTop < st.top
	st.top = el.scrollTop
	st.held = undefined
	if (scroll.gap(el) <= atBottom) pin(true, 'drag')
	else if (up) pin(false, 'drag')
}

// Sets the view's position; the reading anchor follows it.
function put(el: Box, top: number): void {
	el.scrollTop = top
	scroll.moved()
}

// The view moved by our hand (put, a linked card scrolled into view):
// read from here, and do not take the move for the reader's. A resize
// seen before the scroll event would otherwise restore the reading
// anchor from before the move (task 0z).
function moved(): void {
	let st = scroll.state
	if (st.el) st.top = st.el.scrollTop
	st.reanchor()
}

// Runs after anything that may have moved the view or grown the
// content: a scroll event, a DOM change, the tab shown again. `why`
// names the trigger for diagnostics. A scroll event never pulls: the
// content and size observers pull for growth, and pulling against iOS's
// own settling made the view shake (task 981).
function check(why: string): void {
	let st = scroll.state,
		el = st.el
	if (!el) return
	if (why === 'scroll') navigate()
	if (!st.pinned) {
		scroll.keep()
		return
	}
	let g = scroll.gap(el)
	if (g <= atBottom || why === 'scroll') return
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
		if (scroll.state.pinned) {
			scroll.put(el, scroll.target(el, 0))
			return true
		}
		return scroll.keep()
	})
	scroll.state.reanchor = capture
	let scrolled = () => {
		scroll.check('scroll')
		if (scroll.atTop()) onTop()
	}
	el.addEventListener('scroll', scrolled, { passive: true })
	// Streamed text and new cards change the DOM; a change that no
	// follow() covered would otherwise leave a pinned view short.
	let content = new MutationObserver((changes) => {
		if (changes.some((c) => c.target === el && c.type === 'childList')) watchCards()
		scroll.check('content')
	})
	content.observe(el, { childList: true, characterData: true, subtree: true })
	// A card can also grow with no DOM change and no scroll event: its
	// open animation, an image or font arriving. Watch each card's size,
	// so that growth too keeps the bottom. Unobserve removed cards so
	// switching sessions does not retain their DOM.
	let cards = new ResizeObserver(() => scroll.check('resize'))
	let watched = new Set<Element>()
	let watchCards = () => {
		for (let c of watched)
			if (c.parentElement !== el) {
				cards.unobserve(c)
				watched.delete(c)
			}
		for (let c of el.children)
			if (!watched.has(c)) {
				cards.observe(c, { box: 'border-box' })
				watched.add(c)
			}
	}
	watchCards()
	// Catch up after the browser suspends a background tab.
	let shown = () => {
		if (!document.hidden) scroll.check('shown')
	}
	document.addEventListener('visibilitychange', shown)
	// The browser may scroll before it delivers the input event: judge
	// the position again when the event comes.
	let down = () => {
		scroll.state.finger = true
		navigate()
	}
	let up = () => void (scroll.state.finger = false)
	let input = (e: Event) => {
		if (e instanceof KeyboardEvent && (e.target as Element | null)?.closest?.('textarea, input')) return
		scroll.state.input = performance.now()
		navigate()
	}
	el.addEventListener('pointerdown', down, { passive: true })
	el.addEventListener('touchstart', down, { passive: true })
	addEventListener('pointerup', up, { passive: true })
	addEventListener('touchend', up, { passive: true })
	addEventListener('touchcancel', up, { passive: true })
	el.addEventListener('wheel', input, { passive: true })
	addEventListener('keydown', input)
	return () => {
		scroll.state.el = null
		scroll.state.reanchor = () => {}
		stopReflow()
		el.removeEventListener('scroll', scrolled)
		content.disconnect()
		cards.disconnect()
		document.removeEventListener('visibilitychange', shown)
		el.removeEventListener('pointerdown', down)
		el.removeEventListener('touchstart', down)
		removeEventListener('pointerup', up)
		removeEventListener('touchend', up)
		removeEventListener('touchcancel', up)
		el.removeEventListener('wheel', input)
		removeEventListener('keydown', input)
	}
}

// Runs `change`, which must leave the DOM updated (flush() in Solid),
// and keeps a bottom reader at the bottom.
function follow(change: () => void, force = false): void {
	if (force) {
		pin(true, 'force')
		scroll.state.held = undefined
		scroll.onTrace('force')
	}
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
	let place = scroll.state.places.get(id) ?? { gap: 0 }
	// A tab never shown here opens pinned at the bottom.
	pin('gap' in place && place.gap <= atBottom, 'restore')
	scroll.put(el, 'top' in place ? place.top : scroll.target(el, place.gap))
	scroll.onTrace('restore')
}

export const scroll = {
	// Further above the bottom than this shows the scroll-to-bottom pill.
	awayPx: 200,
	nearTop: 800,
	// `reanchor`: takes reflow's reading anchor at the current view.
	// `held`: the card hold() keeps in place, at `top` in the viewport.
	// `top`: the position the reader or Hal last scrolled to. `finger`: a
	// finger or mouse button is down; `input`: when the last wheel or key
	// event came.
	state: {
		el: null as Box | null,
		top: 0,
		reanchor: (): void => {},
		quiet: false,
		finger: false,
		input: -Infinity,
		pinned: true,
		held: undefined as { card: Element; top: number } | undefined,
		places: new Map<string, { top: number } | { gap: number }>(),
	},
	onTrace: (_why: string, _pull?: number): void => {},
	// Following changed.
	onPin: (_why: string): void => {},
	gap,
	leave,
	hold,
	keep,
	put,
	moved,
	check,
	target,
	steering,
	atTop,
	anchor,
	quiet,
	init,
	follow,
	save,
	restore,
}
