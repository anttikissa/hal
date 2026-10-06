/// <reference lib="dom" />
// Following the bottom of the transcript. A reader within `near` px of
// the bottom stays at the same distance from it as content grows (new
// items, streamed text, a card opening); one scrolled further up is
// left alone. The gap is measured before a change, since afterwards
// the page is taller. The view never jumps: one glide chases the
// moving bottom, closing a fixed share of the distance each frame
// (exponential, about the CSS --ease-out), so new items, streamed
// lines and a send landing mid-glide re-aim it without restarting it
// or changing the position at once. A card opening or closing is
// tracked exactly while its height animates; sending glides to the
// very bottom from anywhere.
//
// A catch-up (a reconnect bringing many items) snaps to the bottom at
// once: the rows are replaced and scrollTop resets, and a glide from
// there would sweep the session past the reader.
//
// Wheel, touch or a scroll key cancel a glide: the reader takes over.
// Only scroll keys, since canceling on any key leaves a half-finished
// scroll whose gap then falls outside `near` and stops the follow. A
// send's glide ignores leftover wheel momentum, but a new finger
// gesture always takes over and pauses following until release.
//
// Pinned (the user's rule): a reader at the very bottom stays there
// until they leave it by hand. The 50 px rule alone kept whatever gap
// it found, so anything else that moved the view a few pixels (a tab
// in the background, tool output landing, the browser clamping
// scrollTop) became the new gap, and the view stayed that far short
// for good. While pinned, the gap kept is always 0 and any move or
// growth the reader did not make is pulled back to the bottom.
//
// Only reader input unpins: wheel, touch, scroll keys or Tab, find
// (Cmd/Ctrl+F or G, F3), a press on the scrollbar, a drag that moves
// the view (a selection or middle-button autoscroll, a thumb drag),
// or a link to a block. Unpinning too eagerly is safe, since the view
// pins again whenever it is found at the very bottom; pulling back a
// reader who left on purpose is not, so when unsure, unpin. A send
// pins at once. Unpinned, the 50 px rule above applies as before.
//
// Growth above a still tail snaps (task rha): when the last card is
// the same and nothing below its top changed (queued messages waiting
// at the end while new items land above them), a glide would push that
// tail down and slide it back, so it bounces. Snapping keeps it still.

import { reflow } from './reflow.ts'

type Box = { scrollHeight: number; scrollTop: number; clientHeight: number }
export type Mode = 'glide' | 'snap' | 'track'

// How far the view is above the bottom.
function gap(el: Box): number {
	return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
}

// The gap to keep after a change, or undefined to leave the view
// alone. Mid-glide the gap it heads for counts (a fast stream would
// otherwise outrun `near`); `force` (a send) means the very bottom.
function keep(measured: number, gliding?: number, force = false): number | undefined {
	if (force) return 0
	let g = gliding ?? measured
	return g < scroll.near ? g : undefined
}

// Where the view goes to be `gap` above the bottom.
function target(el: Box, gap: number): number {
	return Math.max(0, el.scrollHeight - el.clientHeight - gap)
}

// Position `ms` after `from` while chasing `to`: the distance shrinks
// by e every `tauMs`, from any start and however `to` moves.
function at(from: number, to: number, ms: number): number {
	let x = from + (to - from) * (1 - Math.exp(-ms / scroll.tauMs))
	return Math.abs(to - x) < 0.5 ? to : x
}

const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

// At most this far above the bottom still counts as at the bottom:
// scroll positions can be fractional.
const atBottom = 1

function stop(): void {
	if (scroll.state.frame) cancelAnimationFrame(scroll.state.frame)
	scroll.state.frame = 0
}

// Whether a send's glide still ignores wheel momentum.
function forced(): boolean {
	return performance.now() < scroll.state.forcedUntil
}

// The reader moved, or may be about to move, the view: stop any glide
// and stop pulling the view back to the bottom.
function leave(): void {
	scroll.stop()
	scroll.state.pinned = false
}

// Wheel and scroll keys. Leftover wheel momentum during a send's glide
// is not a new decision, so it neither stops the glide nor unpins.
function userScroll(): void {
	if (!scroll.forced()) scroll.leave()
}

// A new finger gesture is deliberate, unlike leftover wheel momentum.
// Streaming must not fight it while the finger is dragging away from
// the bottom, even before the gap has crossed the follow threshold.
function touchStart(): void {
	scroll.state.touching = true
	scroll.leave()
	scroll.state.forcedUntil = 0
}

function touchEnd(): void {
	scroll.state.touching = false
}

function onKey(e: KeyboardEvent): void {
	let t = e.target as Element | null
	// Find in page jumps to a match, from any field.
	let find = e.key === 'F3' || ((e.metaKey || e.ctrlKey) && /^[fg]$/i.test(e.key))
	if (find) return scroll.leave()
	// Tab may focus a card off screen, and the browser scrolls it into view.
	if ((scrollKeys.has(e.key) || e.key === 'Tab') && !t?.closest?.('textarea, input')) scroll.userScroll()
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
	// Pinned but above the bottom, and no glide is already on its way:
	// something other than the reader moved the view or grew the
	// content. Pull back, unless a press is under way (a click or the
	// start of a selection must not have the text slide under it).
	if (!st.pinned || st.frame || st.pressing || st.touching) return
	scroll.onPull(g, why)
	scroll.follow(() => {})
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
	scroll.stop()
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

// The last card, how far its top is above the content's bottom, and
// the content's height; in a browser only.
function tail(el: Box): { node: Element; below: number; height: number } | undefined {
	if (typeof Element === 'undefined' || !(el instanceof Element)) return
	let node = el.lastElementChild
	while (node && !node.classList.contains('Card')) node = node.previousElementSibling
	if (!node) return
	return { node, height: el.scrollHeight, below: el.scrollHeight - el.scrollTop - (node.getBoundingClientRect().top - el.getBoundingClientRect().top) }
}

// Whether the change grew the content above the last card only. A
// change that grew nothing (a pull back to the bottom) keeps its glide:
// a snap there would yank a reader the instant they leave the bottom.
function still(el: Box, before: ReturnType<typeof tail>): boolean {
	let after = before && tail(el)
	return !!after && after.node === before!.node && after.height > before!.height && Math.abs(after.below - before!.below) < 1
}

// Follow `el`; returns the cleanup. `onTop`: the reader scrolled near
// the top.
function init(el: HTMLElement, onTop: () => void = () => {}): () => void {
	scroll.state.el = el
	// A resize mid-glide (the message box grows, an image loads) must not
	// cancel it: the glide re-aims at the moving bottom every frame, while
	// the reading anchor was taken mid-way and would strand the view.
	let { stop: stopReflow, capture } = reflow.watch(el, () => {
		if (scroll.state.frame) return true
		// Pinned: the bottom is the anchor, whatever the reading anchor says.
		if (scroll.state.pinned) {
			scroll.put(el, scroll.target(el, 0))
			return true
		}
		scroll.state.forcedUntil = 0
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
	let content = new MutationObserver(() => { watchCards(); scroll.check('content') })
	content.observe(el, { childList: true, characterData: true, subtree: true })
	// A card can also grow with no DOM change and no scroll event: its
	// open animation, an image or font arriving. Watch each card's size,
	// so that growth too pulls a pinned view back. observe() ignores a
	// card already watched; a removed card drops out by itself.
	let cards = new ResizeObserver(() => scroll.check('resize'))
	let watchCards = () => { for (let c of el.children) cards.observe(c, { box: 'border-box' }) }
	watchCards()
	// A background tab gets no animation frames: catch up when shown.
	let shown = () => { if (!document.hidden) scroll.check('shown') }
	document.addEventListener('visibilitychange', shown)
	// A press inside the transcript; on the scrollbar (right of the
	// content box) it is the reader taking the view.
	let press = (e: PointerEvent) => {
		scroll.state.pressing = true
		if (e.target === el && e.offsetX >= el.clientWidth) scroll.leave()
	}
	let release = () => { scroll.state.pressing = false }
	el.addEventListener('pointerdown', press, { passive: true })
	addEventListener('pointerup', release, { passive: true })
	addEventListener('pointercancel', release, { passive: true })
	addEventListener('wheel', scroll.userScroll, { passive: true })
	el.addEventListener('touchstart', scroll.touchStart, { passive: true })
	el.addEventListener('touchend', scroll.touchEnd, { passive: true })
	el.addEventListener('touchcancel', scroll.touchEnd, { passive: true })
	addEventListener('keydown', scroll.onKey)
	return () => {
		scroll.stop()
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
		removeEventListener('wheel', scroll.userScroll)
		el.removeEventListener('touchstart', scroll.touchStart)
		el.removeEventListener('touchend', scroll.touchEnd)
		el.removeEventListener('touchcancel', scroll.touchEnd)
		scroll.state.touching = false
		removeEventListener('keydown', scroll.onKey)
	}
}

// Runs `change`, which must leave the DOM updated (flush() in Solid),
// and keeps a bottom reader at the bottom.
function follow(change: () => void, mode: Mode = 'glide', force = false): void {
	let st = scroll.state
	let el = st.el
	if (!el) return change()
	// A send pins; pinned, the gap to keep is 0 whatever was measured.
	if (force) st.pinned = true
	let g = st.touching && !force ? undefined : scroll.keep(scroll.gap(el), st.frame ? st.gap : undefined, force || st.pinned)
	let last = g !== undefined && mode === 'glide' ? tail(el) : undefined
	change()
	if (g === undefined) return
	if (last && still(el, last)) mode = 'snap'
	st.gap = g
	// A send ignores wheel momentum until its glide lands, at most
	// forcedMs: while a reply streams the glide may never land, and
	// would hold a reader who scrolls up.
	if (force) st.forcedUntil = performance.now() + scroll.forcedMs
	if (mode === 'snap' || matchMedia('(prefers-reduced-motion: reduce)').matches) {
		scroll.stop()
		scroll.put(el, scroll.target(el, g))
		return
	}
	if (mode === 'track') st.exactUntil = performance.now() + scroll.toggleMs
	// A running glide re-aims at the new gap from where it is.
	if (st.frame) return
	st.pos = st.set = el.scrollTop
	let prev = performance.now()
	let step = (now: number) => {
		// Unpinned, anything else moving the view (a wheel this missed)
		// is the reader taking over. Pinned, the reader's input would
		// have unpinned first, so the move is not theirs: carry on.
		if (Math.abs(el.scrollTop - st.set) > 2 && !scroll.forced() && !st.pinned) return void (st.frame = 0)
		// rAF time is the frame's start, which may precede `last`.
		let ms = Math.min(50, Math.max(0, now - prev))
		prev = Math.max(prev, now)
		let to = scroll.target(el, st.gap)
		st.pos = now < st.exactUntil ? to : scroll.at(st.pos, to, ms)
		el.scrollTop = st.pos
		st.set = el.scrollTop
		// Landing ends a send's hold on wheel momentum.
		if (st.pos === to) st.forcedUntil = 0
		st.frame = st.pos !== to || now < st.exactUntil ? requestAnimationFrame(step) : 0
	}
	st.frame = requestAnimationFrame(step)
}

// Each tab keeps its place while another is shown: a reader near the
// bottom comes back to the bottom (it may have grown), one further up
// to the same spot; a tab never shown here opens at the bottom.
function save(id: string): void {
	let el = scroll.state.el
	if (!el) return
	scroll.stop()
	// A pinned reader comes back pinned, even if a drift was not yet
	// pulled back.
	let near = scroll.keep(scroll.gap(el)) !== undefined
	scroll.state.places.set(id, scroll.state.pinned ? { gap: 0 } : near ? { gap: scroll.gap(el) } : { top: el.scrollTop })
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
	near: 50,
	// Further above the bottom than this shows the scroll-to-bottom pill.
	awayPx: 200,
	nearTop: 800,
	// A glide closes 99% of its distance in about 4.6 tauMs.
	tauMs: 45,
	// A card's open and close animation (CSS --toggle-ms matches).
	toggleMs: 250,
	forcedMs: 300,
	// `pinned`: see the header. `pressing`: a mouse button or pen is down
	// in the transcript. `set`: the last position this module set.
	// `reanchor`: takes reflow's reading anchor at the current view.
	state: { el: null as Box | null, reanchor: (): void => {}, quiet: false, frame: 0, gap: 0, pos: 0, set: 0, exactUntil: 0, forcedUntil: 0, touching: false, pinned: true, pressing: false, places: new Map<string, { top: number } | { gap: number }>() },
	// Called when a pinned view is pulled back to the bottom, with the
	// gap found and the trigger. A diagnostics hook (drift.ts); no-op.
	onPull: (_gap: number, _why: string): void => {},
	gap,
	keep,
	leave,
	put,
	moved,
	check,
	target,
	at,
	stop,
	forced,
	userScroll,
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
