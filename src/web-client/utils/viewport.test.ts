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
