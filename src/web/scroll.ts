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
// Only scroll keys, since cancelling on any key leaves a half-finished
// scroll whose gap then falls outside `near` and stops the follow. A
// send's glide ignores leftover wheel momentum, but a new finger
// gesture always takes over and pauses following until release.

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

function stop(): void {
	if (scroll.state.frame) cancelAnimationFrame(scroll.state.frame)
	scroll.state.frame = 0
}

// Whether a send's glide still ignores wheel momentum.
function forced(): boolean {
	return performance.now() < scroll.state.forcedUntil
}

function userScroll(): void {
	if (!scroll.forced()) scroll.stop()
}

// A new finger gesture is deliberate, unlike leftover wheel momentum.
// Streaming must not fight it while the finger is dragging away from
// the bottom, even before the gap has crossed the follow threshold.
function touchStart(): void {
	scroll.state.touching = true
	scroll.stop()
	scroll.state.forcedUntil = 0
}

function touchEnd(): void {
	scroll.state.touching = false
}

function onKey(e: KeyboardEvent): void {
	let t = e.target as Element | null
	if (scrollKeys.has(e.key) && !t?.closest?.('textarea, input')) scroll.userScroll()
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
	el.scrollTop = Math.max(0, el.scrollHeight - below)
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
	// A resize mid-glide (the message box grows, an image loads) must not
	// cancel it: the glide re-aims at the moving bottom every frame, while
	// the reading anchor was taken mid-way and would strand the view.
	let stopReflow = reflow.watch(el, () => {
		if (scroll.state.frame) return true
		scroll.state.forcedUntil = 0
		return false
	})
	let scrolled = () => scroll.atTop() && onTop()
	el.addEventListener('scroll', scrolled, { passive: true })
	addEventListener('wheel', scroll.userScroll, { passive: true })
	el.addEventListener('touchstart', scroll.touchStart, { passive: true })
	el.addEventListener('touchend', scroll.touchEnd, { passive: true })
	el.addEventListener('touchcancel', scroll.touchEnd, { passive: true })
	addEventListener('keydown', scroll.onKey)
	return () => {
		scroll.stop()
		scroll.state.el = null
		stopReflow()
		el.removeEventListener('scroll', scrolled)
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
	let g = st.touching && !force ? undefined : scroll.keep(scroll.gap(el), st.frame ? st.gap : undefined, force)
	change()
	if (g === undefined) return
	st.gap = g
	// A send ignores wheel momentum until its glide lands, at most
	// forcedMs: while a reply streams the glide may never land, and
	// would hold a reader who scrolls up.
	if (force) st.forcedUntil = performance.now() + scroll.forcedMs
	if (mode === 'snap' || matchMedia('(prefers-reduced-motion: reduce)').matches) {
		scroll.stop()
		el.scrollTop = scroll.target(el, g)
		return
	}
	if (mode === 'track') st.exactUntil = performance.now() + scroll.toggleMs
	// A running glide re-aims at the new gap from where it is.
	if (st.frame) return
	st.pos = st.set = el.scrollTop
	let last = performance.now()
	let step = (now: number) => {
		// Anything else moving the view (a scrollbar drag, a wheel this
		// missed) is the reader taking over.
		if (Math.abs(el.scrollTop - st.set) > 2 && !scroll.forced()) return void (st.frame = 0)
		// rAF time is the frame's start, which may precede `last`.
		let ms = Math.min(50, Math.max(0, now - last))
		last = Math.max(last, now)
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
	let near = scroll.keep(scroll.gap(el)) !== undefined
	scroll.state.places.set(id, near ? { gap: scroll.gap(el) } : { top: el.scrollTop })
}

function restore(id: string): void {
	let el = scroll.state.el
	if (!el) return
	let place = scroll.state.places.get(id) ?? { gap: 0 }
	el.scrollTop = 'top' in place ? place.top : scroll.target(el, place.gap)
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
	state: { el: null as Box | null, quiet: false, frame: 0, gap: 0, pos: 0, set: 0, exactUntil: 0, forcedUntil: 0, touching: false, places: new Map<string, { top: number } | { gap: number }>() },
	gap,
	keep,
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
