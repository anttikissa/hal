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
	expect(element.scrollTop).toBe(834)
})

test('recognizes a scroller within 50 pixels of the bottom', () => {
	const element = fakeScroller({ scrollHeight: 1_234, clientHeight: 1_000, scrollTop: 185 })
	expect(webScroll.bottomGap(element)).toBe(49)
	element.scrollTop = 184
	expect(webScroll.bottomGap(element)).toBeNull()
})

test('preserves the exact bottom gap across content growth', () => {
	const values = { scrollHeight: 1_234, clientHeight: 1_000, scrollTop: 214 }
	const element = fakeScroller(values)
	const gap = webScroll.bottomGap(element)
	expect(gap).toBe(20)
	values.scrollHeight += 100
	webScroll.toBottom(element, gap!)
	expect(element.scrollTop).toBe(314)
	element.scrollTop = 284 // 50px away: do not follow.
	expect(webScroll.bottomGap(element)).toBeNull()
})
