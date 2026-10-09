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
	// Pinching/panning while typing changes width too: the app follows the
	// visible rectangle so the composer stays on screen.
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

test('a stale keyboard-height visual viewport yields to the layout one while no field could hold a keyboard', () => {
	let noop = () => {}
	let source = { width: 393, height: 485, offsetLeft: 0, offsetTop: 0, addEventListener: noop, removeEventListener: noop }
	let focus: (() => void) | undefined
	let resume = { addEventListener: (_: string, f: () => void) => void (focus = f), removeEventListener: noop }
	let typing = true
	let css: Record<string, string> = {}
	viewport.sync(source, { setProperty: (k: string, v: string | null) => void (css[k] = v ?? '') }, () => (typing ? undefined : { width: 393, height: 793, offsetLeft: 0, offsetTop: 0 }), [[resume, ['focusout']]])
	expect(css['--app-height']).toBe('485px')
	// The stale viewport fires nothing; the focus change re-reads it.
	typing = false
	focus!()
	expect(css['--app-height']).toBe('793px')
})
