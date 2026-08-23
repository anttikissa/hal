import { expect, test } from 'bun:test'
import { webScroll } from './scroll.ts'

// The transcript is its own scroll container, so these helpers work on that
// element rather than on the document viewport.
function fakeScroller(values: { scrollHeight: number; clientHeight: number; scrollTop: number }): HTMLElement {
	return values as unknown as HTMLElement
}

test('scrolls the transcript to its bottom', () => {
	const element = fakeScroller({ scrollHeight: 1_234, clientHeight: 400, scrollTop: 0 })
	webScroll.toBottom(element)
	expect(element.scrollTop).toBe(1_234)
})

test('recognizes a scroller within 25 pixels of the bottom', () => {
	const element = fakeScroller({ scrollHeight: 1_234, clientHeight: 1_000, scrollTop: 210 })
	expect(webScroll.isNearBottom(element)).toBe(true)
	element.scrollTop = 209
	expect(webScroll.isNearBottom(element)).toBe(false)
})
