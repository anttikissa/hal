import { expect, test } from 'bun:test'
import { scroll } from './scroll.ts'

const box = (scrollHeight: number, scrollTop: number, clientHeight: number) => ({ scrollHeight, scrollTop, clientHeight })

test('the gap is how far the view is above the bottom', () => {
	expect(scroll.gap(box(1000, 600, 400))).toBe(0)
	expect(scroll.gap(box(1000, 580, 400))).toBe(20)
	// Content shorter than the view is at the bottom.
	expect(scroll.gap(box(400, 0, 400))).toBe(0)
})

test('a reader near the bottom keeps their gap; one further up is left alone', () => {
	expect(scroll.keep(0)).toBe(0)
	expect(scroll.keep(20)).toBe(20)
	expect(scroll.keep(49)).toBe(49)
	expect(scroll.keep(50)).toBeUndefined()
	expect(scroll.keep(400)).toBeUndefined()
})

test('mid-glide the gap it heads for counts, not the half-finished scroll', () => {
	// A fast stream outruns the glide: measured 120 px up, heading for 10.
	expect(scroll.keep(120, 10)).toBe(10)
})

test('sending lands at the very bottom from anywhere', () => {
	expect(scroll.keep(5000, undefined, true)).toBe(0)
	expect(scroll.keep(30, 30, true)).toBe(0)
})

test('the target keeps the gap after growth, never above the top', () => {
	// 20 px up before; the page grew by 300.
	expect(scroll.target(box(1300, 580, 400), 20)).toBe(880)
	expect(scroll.target(box(300, 0, 400), 20)).toBe(0)
})

test('a glide eases out: starts fast, lands exactly', () => {
	expect(scroll.at(100, 500, 0)).toBe(100)
	expect(scroll.at(100, 500, 1)).toBe(500)
	// Past halfway in distance well before halfway in time.
	expect(scroll.at(0, 100, 0.25)).toBeGreaterThan(50)
	let a = scroll.at(0, 100, 0.5)
	let b = scroll.at(0, 100, 0.6)
	expect(b).toBeGreaterThan(a)
	expect(b).toBeLessThan(100)
})

test('each tab keeps its place: a bottom reader returns to the (grown) bottom, others to their spot', () => {
	let el = box(1000, 600, 400)
	scroll.state.el = el
	try {
		scroll.save('1-aaa')
		el.scrollTop = 100
		scroll.save('2-bbb')
		// Another tab shows, then each comes back, longer than before.
		el.scrollHeight = 1500
		scroll.restore('1-aaa')
		expect(el.scrollTop).toBe(1100)
		scroll.restore('2-bbb')
		expect(el.scrollTop).toBe(100)
		// A tab never shown here opens at the bottom.
		el.scrollTop = 0
		scroll.restore('3-ccc')
		expect(el.scrollTop).toBe(1100)
	} finally {
		scroll.state.el = null
		scroll.state.places.clear()
	}
})

test('earlier history put above keeps what the reader was reading in place', () => {
	let el = box(1000, 300, 400)
	let saved = scroll.state.el
	scroll.state.el = el
	try {
		scroll.anchor(() => (el.scrollHeight = 1700))
		expect(el.scrollTop).toBe(1000)
		expect(scroll.atTop()).toBe(false)
		el.scrollTop = 10
		expect(scroll.atTop()).toBe(true)
	} finally {
		scroll.state.el = saved
	}
})
