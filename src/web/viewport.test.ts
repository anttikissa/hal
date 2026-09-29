import { expect, test } from 'bun:test'
import { viewport } from './viewport.ts'

test('the page follows the visual viewport as the keyboard opens, until stopped; without one nothing is written', () => {
	let listeners = new Map<string, () => void>()
	let source = {
		width: 390,
		height: 800,
		offsetLeft: 0,
		offsetTop: 0,
		addEventListener: (type: string, f: () => void) => void listeners.set(type, f),
		removeEventListener: (type: string, f: () => void) => void (listeners.get(type) === f && listeners.delete(type)),
	}
	let css: Record<string, string> = {}
	let stop = viewport.sync(source, { setProperty: (k: string, v: string | null) => void (css[k] = v ?? '') })
	expect(css).toEqual({ '--app-width': '390px', '--app-height': '800px', '--app-left': '0px', '--app-top': '0px' })
	// The keyboard shrinks the viewport, then Safari pans it down.
	source.height = 450
	listeners.get('resize')!()
	source.offsetTop = 120
	listeners.get('scroll')!()
	expect(css).toEqual({ '--app-width': '390px', '--app-height': '450px', '--app-left': '0px', '--app-top': '120px' })
	// Pinching/panning changes width too: the app must reflow into the
	// visible rectangle instead of leaving the menu off its left edge.
	source.width = 195
	source.height = 225
	source.offsetLeft = 90
	listeners.get('resize')!()
	listeners.get('scroll')!()
	expect(css).toEqual({ '--app-width': '195px', '--app-height': '225px', '--app-left': '90px', '--app-top': '120px' })
	stop()
	expect(listeners.size).toBe(0)
	let written = 0
	viewport.sync(undefined, { setProperty: () => void written++ })()
	expect(written).toBe(0)
})
