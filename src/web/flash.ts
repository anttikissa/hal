// Press and arrival feedback (task fbr): an element turns white at
// once and decays to its own background, exponential-like. A pressed
// button flashes briefly; a card reached by its address (a link, /go)
// flashes slowly, so the reader sees where they landed.

const decay = 'cubic-bezier(0.16, 1, 0.3, 1)'

// Flashes `el` white for `ms`, ending at its current background.
function on(el: Element, ms: number): void {
	let style = getComputedStyle(el)
	let from = style.getPropertyValue('--flash')
	el.animate([{ backgroundColor: from }, { backgroundColor: style.backgroundColor }], { duration: ms, easing: decay })
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
		if (held && !(held as HTMLButtonElement).disabled) flash.on(held, 450)
	}
	let click = (e: MouseEvent) => {
		let b = button(e)
		if (b && b !== held && !b.disabled) flash.on(b, 450)
		held = null
	}
	document.addEventListener('pointerdown', down, true)
	document.addEventListener('click', click, true)
	return () => {
		document.removeEventListener('pointerdown', down, true)
		document.removeEventListener('click', click, true)
	}
}

export const flash = { on, buttons, card: (el: Element) => flash.on(el, 1600) }
