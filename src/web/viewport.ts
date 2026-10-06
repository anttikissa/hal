// The page fits the visual viewport. iOS Safari ignores
// interactive-widget=resizes-content (WebKit bug 259770): when the
// on-screen keyboard opens it shrinks and pans the visual viewport while
// the layout viewport, and so 100dvh, stays full height, which would
// hide the composer under the keyboard or the tab strip off the top.
// So the visual viewport's height and offset go into CSS custom
// properties (--app-height, --app-top) that size and translate the app;
// without visualViewport the CSS keeps 100dvh. Chrome and Firefox
// honor the meta tag, and the same numbers are right there too.
//
// The iOS Home Screen app's visual viewport can keep a keyboard-reduced
// height (e.g. 485 of 793 px, offset 0) for minutes after the keyboard
// is gone, across resumes and even from page load, while innerHeight is
// right (task m7). A keyboard needs a focused text field, so with none
// and no pinch zoom the app fills the layout viewport (`full`) instead.

export type Box = { width: number; height: number; offsetLeft: number; offsetTop: number }

type Events = {
	addEventListener: (type: string, listener: () => void) => void
	removeEventListener: (type: string, listener: () => void) => void
}
type Source = Box & Events

// offsetTop is how far the browser has panned the visual viewport down
// the layout viewport; translating the app there puts it back on screen.
function css(box: Box): Record<string, string> {
	return { '--app-width': `${box.width}px`, '--app-height': `${box.height}px`, '--app-left': `${box.offsetLeft}px`, '--app-top': `${box.offsetTop}px` }
}

// Mirrors `source` into `style` now and on every change, or `full()`
// when it answers a box; `also` lists other targets and events that
// call for a fresh look. Answers the function that stops.
function sync(source: Source | undefined, style: Pick<CSSStyleDeclaration, 'setProperty'>, full: () => Box | undefined = () => undefined, also: [Events, string[]][] = []): () => void {
	if (!source) return () => {}
	let write = () => {
		for (let [k, v] of Object.entries(css(full() ?? source))) style.setProperty(k, v)
	}
	write()
	// Safari reports the keyboard as a resize, then the offset as it
	// settles as a scroll.
	let on: [Events, string[]][] = [[source, ['resize', 'scroll']], ...also]
	for (let [target, types] of on) for (let type of types) target.addEventListener(type, write)
	return () => {
		for (let [target, types] of on) for (let type of types) target.removeEventListener(type, write)
	}
}

// The page's wiring: the layout viewport while no text field has focus
// and nothing is zoomed; re-read when focus moves, the window resizes
// and the app resumes, since a stale visual viewport fires no event.
function page(): () => void {
	let vv = visualViewport ?? undefined
	let typing = () => {
		let e = document.activeElement
		return e instanceof HTMLTextAreaElement || (e instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'file', 'submit', 'reset', 'range', 'color'].includes(e.type)) || (e instanceof HTMLElement && e.isContentEditable)
	}
	let full = () => (!vv || vv.scale > 1.01 || typing() ? undefined : { width: innerWidth, height: innerHeight, offsetLeft: 0, offsetTop: 0 })
	let root = document.documentElement
	// The app follows an opening keyboard at once, so the composer is
	// never hidden; when it closes, html.easing lets the composer glide
	// down on an S curve (index.html) rather than drop with the
	// keyboard, so the Send button's flash stays in sight.
	let last = 0, timer: ReturnType<typeof setTimeout> | undefined
	let style = { setProperty(k: string, v: string) {
		if (k === '--app-height') {
			let h = parseFloat(v)
			if (last && h > last + 100 && matchMedia('(pointer: coarse)').matches) {
				root.classList.add('easing')
				clearTimeout(timer)
				timer = setTimeout(() => root.classList.remove('easing'), 460)
			}
			last = h
		}
		root.style.setProperty(k, v)
	} }
	return sync(vv, style, full, [[window, ['resize', 'pageshow']], [document, ['focusin', 'focusout', 'visibilitychange']]])
}

// iOS scrolls the document to its top when the status bar is tapped,
// and tells the page nothing else. The document is 1px taller than the
// screen (index.html) and parked at scrollY 1, so reaching 0 means a tap
// and `top` runs. Keyboard and viewport changes can also move the
// document, so 0 within 600 ms of one is ignored, then re-parked.
function statusTap(top: () => void): () => void {
	let quietUntil = 0
	let park = () => { if (scrollY !== 1 && !document.activeElement?.matches('textarea, input')) scrollTo(0, 1) }
	let settle = () => { quietUntil = performance.now() + 600; setTimeout(park, 300) }
	// Typing restores the locked layout (index.html, html.typing): the
	// keyboard must not be able to pan a scrollable document.
	let typing = () => {
		let on = !!document.activeElement?.matches('textarea, input')
		if (on === document.documentElement.classList.contains('typing')) return
		quietUntil = performance.now() + 600
		if (on) scrollTo(0, 0)
		document.documentElement.classList.toggle('typing', on)
	}
	let focus = () => { typing(); settle() }
	let onScroll = () => {
		if (scrollY > 0) return
		if (performance.now() > quietUntil) top()
		requestAnimationFrame(park)
	}
	let vv = visualViewport
	let on: [EventTarget | null, string, () => void][] = [[window, 'scroll', onScroll], [window, 'pageshow', settle], [document, 'focusin', focus], [document, 'focusout', () => setTimeout(focus)], [vv, 'resize', settle]]
	for (let [t, k, f] of on) t?.addEventListener(k, f, { passive: true })
	focus()
	return () => { for (let [t, k, f] of on) t?.removeEventListener(k, f); document.documentElement.classList.remove('typing') }
}

export const viewport = { css, sync, page, statusTap }
