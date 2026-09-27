import { expect, test } from 'bun:test'
import { viewport } from './viewport.ts'

test('the page follows the visual viewport as the keyboard opens, until stopped', () => {
	let listeners = new Map<string, () => void>()
	let source = {
		height: 800,
		offsetTop: 0,
		addEventListener: (type: string, f: () => void) => void listeners.set(type, f),
		removeEventListener: (type: string, f: () => void) => void (listeners.get(type) === f && listeners.delete(type)),
	}
	let css: Record<string, string> = {}
	let stop = viewport.sync(source, { setProperty: (k: string, v: string | null) => void (css[k] = v ?? '') })
	expect(css).toEqual({ '--app-height': '800px', '--app-top': '0px' })
	// The keyboard shrinks the viewport, then Safari pans it down.
	source.height = 450
	listeners.get('resize')!()
	source.offsetTop = 120
	listeners.get('scroll')!()
	expect(css).toEqual({ '--app-height': '450px', '--app-top': '120px' })
	stop()
	expect(listeners.size).toBe(0)
})

test('without visualViewport nothing is written and the CSS keeps 100dvh', () => {
	let written = 0
	viewport.sync(undefined, { setProperty: () => void written++ })()
	expect(written).toBe(0)
})
