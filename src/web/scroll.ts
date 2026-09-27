/// <reference lib="dom" />
// Following the bottom of the transcript. A reader within `near` px of
// the bottom stays at the same distance from it as content grows (new
// items, streamed text, a card opening); one scrolled further up is
// left alone. The gap is measured before a change, since afterwards
// the page is taller. New items glide there (strong ease-out),
// streamed lines jump (a glide over one line looks janky), a card
// opening or closing is tracked every frame while its height animates,
// and sending glides to the very bottom from anywhere.
//
// Wheel, touch or a scroll key cancel a glide: the reader takes over.
// Only scroll keys, since cancelling on any key leaves a half-finished
// scroll whose gap then falls outside `near` and stops the follow. A
// send's glide is not cancelled: trackpad momentum keeps firing wheel
// events for a second after the fingers lift.

type Box = { scrollHeight: number; scrollTop: number; clientHeight: number }
export type Mode = 'glide' | 'jump' | 'track'

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
	return g < scroll.near() ? g : undefined
}

// Where the view goes to be `gap` above the bottom.
function target(el: Box, gap: number): number {
	return Math.max(0, el.scrollHeight - el.clientHeight - gap)
}

// Position at time t (0..1) of a glide from `from` to `to`: quintic
// ease-out, the same curve as the CSS --ease-out.
function at(from: number, to: number, t: number): number {
	return from + (to - from) * (1 - (1 - t) ** 5)
}

const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

function stop(): void {
	if (scroll.state.frame) cancelAnimationFrame(scroll.state.frame)
	scroll.state.frame = 0
}

function userScroll(): void {
	if (!scroll.state.forced) scroll.stop()
}

function onKey(e: KeyboardEvent): void {
	let t = e.target as Element | null
	if (scrollKeys.has(e.key) && !t?.closest?.('textarea, input')) scroll.userScroll()
}

// Follow `el`; returns the cleanup.
function init(el: HTMLElement): () => void {
	scroll.state.el = el
	addEventListener('wheel', scroll.userScroll, { passive: true })
	addEventListener('touchstart', scroll.userScroll, { passive: true })
	addEventListener('keydown', scroll.onKey)
	return () => {
		scroll.stop()
		scroll.state.el = null
		removeEventListener('wheel', scroll.userScroll)
		removeEventListener('touchstart', scroll.userScroll)
		removeEventListener('keydown', scroll.onKey)
	}
}

// Runs `change`, which must leave the DOM updated (flush() in Solid),
// and keeps a bottom reader at the bottom.
function follow(change: () => void, mode: Mode = 'glide', force = false): void {
	let st = scroll.state
	let el = st.el
	if (!el) return change()
	let g = scroll.keep(scroll.gap(el), st.frame ? st.gap : undefined, force)
	change()
	// A running glide re-aims at the moving bottom every frame.
	if (g === undefined || (mode === 'jump' && st.frame)) return
	scroll.stop()
	st.gap = g
	st.forced = force
	if (mode === 'jump' || matchMedia('(prefers-reduced-motion: reduce)').matches) {
		el.scrollTop = scroll.target(el, g)
		return
	}
	let from = el.scrollTop
	let started = performance.now()
	let ms = mode === 'track' ? scroll.toggleMs() : scroll.glideMs()
	let step = (now: number) => {
		let t = Math.min(1, (now - started) / ms)
		// The end moves while a card animates or text streams in.
		let to = scroll.target(el, g)
		el.scrollTop = mode === 'track' ? to : scroll.at(from, to, t)
		st.frame = t < 1 ? requestAnimationFrame(step) : 0
		if (!st.frame) st.forced = false
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
	near: () => 50,
	glideMs: () => 200,
	// A card's open and close animation (CSS --toggle-ms matches).
	toggleMs: () => 250,
	state: { el: null as Box | null, frame: 0, gap: 0, forced: false, places: new Map<string, { top: number } | { gap: number }>() },
	gap,
	keep,
	target,
	at,
	stop,
	userScroll,
	onKey,
	init,
	follow,
	save,
	restore,
}
