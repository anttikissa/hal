import { expect, test } from 'bun:test'
import { webScroll } from './scroll.ts'

test('scrolls the document viewport to its bottom', () => {
	const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
	const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
	const calls: ScrollToOptions[] = []
	Object.defineProperty(globalThis, 'window', { configurable: true, value: { scrollTo: (options: ScrollToOptions) => calls.push(options) } })
	Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { scrollHeight: 1_234 } } })
	try {
		webScroll.toBottom()
		expect(calls).toEqual([{ top: 1_234 }])
	} finally {
		if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
		else delete (globalThis as { window?: unknown }).window
		if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
		else delete (globalThis as { document?: unknown }).document
	}
})
