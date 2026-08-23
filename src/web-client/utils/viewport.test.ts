import { expect, test } from 'bun:test'
import { webViewport } from './viewport.ts'

// Fakes rather than a DOM: we assert what we write and when, not layout.
function fakeStyle(): { properties: Map<string, string> } & Pick<CSSStyleDeclaration, 'setProperty'> {
	const properties = new Map<string, string>()
	return { properties, setProperty: (name: string, value: string) => { properties.set(name, value) } }
}

function fakeViewport(height: number, offsetTop: number) {
	const listeners: Record<string, (() => void)[]> = {}
	return {
		height,
		offsetTop,
		listeners,
		addEventListener(type: string, listener: () => void) {
			listeners[type] ??= []
			listeners[type].push(listener)
		},
		emit(type: string) {
			for (const listener of listeners[type] ?? []) listener()
		},
	}
}

test('mirrors the visual viewport into the app box', () => {
	expect(webViewport.cssValues({ height: 640, offsetTop: 0 })).toEqual({ '--app-height': '640px', '--app-top': '0px' })
	// Keyboard open: shorter visible area, and Safari has scrolled it down the page.
	expect(webViewport.cssValues({ height: 350, offsetTop: 74 })).toEqual({ '--app-height': '350px', '--app-top': '74px' })
})

test('writes the current viewport immediately and on every viewport change', () => {
	const style = fakeStyle()
	const viewport = fakeViewport(640, 0)
	webViewport.sync(viewport, style)
	expect(style.properties.get('--app-height')).toBe('640px')

	// The on-screen keyboard shrinks and offsets the visual viewport; Safari fires
	// resize and scroll on visualViewport rather than resizing the layout viewport.
	viewport.height = 350
	viewport.offsetTop = 74
	viewport.emit('resize')
	expect(style.properties.get('--app-height')).toBe('350px')
	expect(style.properties.get('--app-top')).toBe('74px')

	viewport.offsetTop = 0
	viewport.emit('scroll')
	expect(style.properties.get('--app-top')).toBe('0px')
})

test('does nothing without visualViewport so the CSS dvh fallback stays in charge', () => {
	const style = fakeStyle()
	webViewport.sync(undefined, style)
	expect(style.properties.size).toBe(0)
})
