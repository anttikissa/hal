/// <reference lib="dom" />
// Follow the live end until the reader leaves it. In normal document flow,
// output below a reader cannot displace the text above it.
type Box = Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>
type Place = { key: string | undefined; offset: number; fallback: number }
let lastLiveTop = 0
let live = true
function gap(el: Box) {
	return Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop)
}
// Names why the view moves, for the opt-in scroll probe (scroll-debug.ts).
function note(why: string) {
	scroll.state.note?.(why)
}
function bottom(smooth = false) {
	note('bottom')
	scroll.state.showEnd?.()
	live = true
	let el = scroll.state.el
	if (el) {
		if (gap(el) > 0) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' })
		lastLiveTop = el.scrollTop
	}
}
// A far jump: the transcript fades out, jumps with scrolling off (iOS
// momentum outlives scrollTop writes and would carry the view back),
// then fades back in. A near one scrolls smoothly instead.
let dimmed: Animation | undefined
function near(distance: number) {
	let el = scroll.state.el
	return !!el && !scroll.state.moving?.() && Math.abs(distance) < 2 * el.clientHeight
}
function dim(ms = 150) {
	dimmed?.cancel()
	dimmed = scroll.state.el?.animate({ opacity: [1, 0] }, { duration: ms, easing: 'ease-in-out', fill: 'forwards' })
}
function undim() {
	let d = dimmed
	dimmed = undefined
	d?.reverse()
	if (d) d.onfinish = () => d.cancel()
}
function land(jump: () => void) {
	let el = scroll.state.el
	if (dimmed?.playState === 'running') return void (dimmed.onfinish = () => land(jump))
	note('land')
	if (!el) return jump()
	el.style.overflow = 'hidden'
	jump()
	requestAnimationFrame(() => {
		el.style.overflow = ''
		undim()
	})
}
function reading() {
	live = false
}
function atTop() {
	let el = scroll.state.el
	return !!el && el.scrollTop - scroll.state.pad < scroll.nearTop
}
function quiet(change: () => void): void {
	scroll.state.quiet = true
	try {
		change()
	} finally {
		scroll.state.quiet = false
	}
}

function prepend(change: () => void) {
	let el = scroll.state.el,
		row = el?.querySelector('.rows > [data-scroll-key]')
	if (!el || !row || live || (el.scrollTop > 0 && CSS.supports('overflow-anchor', 'auto'))) return quiet(change)
	let y = row.getBoundingClientRect().top
	quiet(change)
	if (row.isConnected) {
		let shift = row.getBoundingClientRect().top - y
		if (shift) note('prepend')
		if (shift) el.scrollTop += shift
	}
}
function init(el: HTMLElement, onTop: () => void, onSettle: () => void) {
	scroll.state.el = el
	live = true
	let rows = el.querySelector(':scope > .rows')!
	let hold = () => {
		if (!live) return
		note('follow')
		bottom()
	}
	let commits = new MutationObserver(hold)
	commits.observe(rows, { childList: true, subtree: true, characterData: true })
	let observer = new ResizeObserver(hold)
	observer.observe(rows)
	observer.observe(el)
	let touching = false,
		moving = false,
		timer: ReturnType<typeof setTimeout> | undefined
	let settled = () => {
		if (touching || !moving) return
		moving = false
		note('settled')
		onSettle()
		if (!live && atTop()) onTop()
	}
	let arm = () => {
		clearTimeout(timer)
		if (!('onscrollend' in el)) timer = setTimeout(settled, 200)
	}
	let release = () => {
		reading()
		moving = true
		arm()
	}
	let touch = () => {
		touching = true
		release()
	}
	let lift = () => {
		touching = false
		arm()
	}
	let scrolled = () => {
		if (!live || el.scrollTop < lastLiveTop - 1) live = gap(el) < 2
		if (moving) arm()
		if (!live && atTop() && (!moving || CSS.supports('overflow-anchor', 'auto'))) onTop()
	}
	scroll.state.moving = () => moving
	scroll.state.pageReady = () => {
		if (!moving || CSS.supports('overflow-anchor', 'auto')) onTop()
	}
	el.addEventListener('touchend', lift, { passive: true })
	el.addEventListener('touchcancel', lift, { passive: true })
	el.addEventListener('scrollend', settled)
	el.addEventListener('wheel', release, { passive: true })
	el.addEventListener('touchmove', touch, { passive: true })
	el.addEventListener('scroll', scrolled, { passive: true })
	bottom()
	return () => {
		clearTimeout(timer)
		el.removeEventListener('touchend', lift)
		el.removeEventListener('touchcancel', lift)
		el.removeEventListener('scrollend', settled)
		commits.disconnect()
		observer.disconnect()
		el.removeEventListener('wheel', release)
		el.removeEventListener('touchmove', touch)
		el.removeEventListener('scroll', scrolled)
		scroll.state.moving = undefined
		scroll.state.pageReady = undefined
		scroll.state.el = null
	}
}
function save(id: string) {
	let el = scroll.state.el
	if (!el) return
	if (gap(el) < 2) {
		scroll.state.places.delete(id)
		return
	}
	let top = el.getBoundingClientRect().top
	let row = [...el.querySelectorAll<HTMLElement>('.rows > [data-scroll-key]')].find(
		(r) => r.getBoundingClientRect().bottom > top,
	)
	scroll.state.places.set(id, {
		key: row?.dataset.scrollKey,
		offset: row ? row.getBoundingClientRect().top - top : 0,
		fallback: el.scrollTop,
	})
}
function restore(id: string) {
	let el = scroll.state.el,
		place = scroll.state.places.get(id)
	if (!el) return
	note('restore')
	if (!place) return bottom()
	live = false
	let row = place.key && el.querySelector<HTMLElement>(`[data-scroll-key="${CSS.escape(place.key)}"]`)
	if (row) el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - place.offset
	else el.scrollTop = place.fallback
}
export const scroll = {
	awayPx: 200,
	nearTop: 800,
	state: {
		showEnd: undefined as (() => void) | undefined,
		note: undefined as ((why: string) => void) | undefined,
		moving: undefined as (() => boolean) | undefined,
		pageReady: undefined as (() => void) | undefined,
		el: null as HTMLElement | null,
		// The space above the rows (Transcript.tsx), so the top is measured from the rows.
		pad: 0,
		quiet: false,
		places: new Map<string, Place>(),
	},
	gap,
	note,
	bottom,
	near,
	dim,
	undim,
	land,
	reading,
	atTop,
	quiet,
	prepend,
	init,
	save,
	restore,
}
