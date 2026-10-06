// Press and arrival feedback (task fbr): an element turns white at
// once and the white decays exponentially. A pressed button flashes
// briefly; a card reached by its address (a link, /go) flashes slowly,
// so the reader sees where they landed.
//
// The white is an inset shadow over the whole padding box: it sits
// above the background and below the content, and leaves the
// background free to change mid-flash (Send turning into Steer).

// White's share at each tenth of the flash: e^(-5t), from 100% down,
// ending at 0%.
const steps = Array.from({ length: 11 }, (_, i) => (i < 10 ? Math.round(100 * Math.exp(-i / 2)) : 0))

// Flashes `el` white for `ms`, keeping its own shadow.
function on(el: Element, ms: number): void {
	let style = getComputedStyle(el)
	let white = style.getPropertyValue('--flash')
	let own = style.boxShadow === 'none' ? '' : `, ${style.boxShadow}`
	let frames = steps.map((p) => ({ boxShadow: `inset 0 0 0 100vmax color-mix(in oklab, ${white} ${p}%, transparent)${own}` }))
	el.animate(frames, { duration: ms })
}

const button = (e: Event) => (e.target instanceof Element ? e.target.closest('button') : null)

// Flashes every button as it is pressed: a mouse on pointerdown; a
// touch on click, so a scroll starting on a button does not flash; a
// key (Enter, Space) on its click. Returns the uninstaller.
function buttons(): () => void {
	// The button a mouse flashed: its click (a MouseEvent in Safari,
	// without pointerType) must not flash again.
	let held: Element | null = null
	let down = (e: PointerEvent) => {
		held = e.pointerType === 'mouse' && e.button === 0 ? button(e) : null
		if (held && !(held as HTMLButtonElement).disabled) flash.on(held, 700)
	}
	let click = (e: MouseEvent) => {
		let b = button(e)
		if (b && b !== held && !b.disabled) flash.on(b, 700)
		held = null
	}
	document.addEventListener('pointerdown', down, true)
	document.addEventListener('click', click, true)
	return () => {
		document.removeEventListener('pointerdown', down, true)
		document.removeEventListener('click', click, true)
	}
}

export const flash = { on, buttons, card: (el: Element) => flash.on(el, 2000) }
