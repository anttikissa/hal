import { expect, test } from 'bun:test'
import { scroll } from './scroll.ts'

const box = (scrollHeight: number, scrollTop: number, clientHeight: number) => ({ scrollHeight, scrollTop, clientHeight })

test('the gap is how far the view is above the bottom', () => {
	expect(scroll.gap(box(1000, 600, 400))).toBe(0)
	expect(scroll.gap(box(1000, 580, 400))).toBe(20)
	// Content shorter than the view is at the bottom.
	expect(scroll.gap(box(400, 0, 400))).toBe(0)
})

test('a reader near the bottom keeps their gap, one further up is left alone; mid-glide the aim counts; sending lands at the bottom', () => {
	expect(scroll.keep(0)).toBe(0)
	expect(scroll.keep(49)).toBe(49)
	expect(scroll.keep(50)).toBeUndefined()
	// A fast stream outruns the glide: measured 120 px up, heading for 10.
	expect(scroll.keep(120, 10)).toBe(10)
	expect(scroll.keep(5000, undefined, true)).toBe(0)
	expect(scroll.keep(30, 30, true)).toBe(0)
})

test('the target keeps the gap after growth, never above the top', () => {
	// 20 px up before; the page grew by 300.
	expect(scroll.target(box(1300, 580, 400), 20)).toBe(880)
	expect(scroll.target(box(300, 0, 400), 20)).toBe(0)
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

test('a finger takes over a send glide and streamed updates do not fight its drag', () => {
	let original = { ...scroll.state }
	let cancel = globalThis.cancelAnimationFrame
	let cancelled = 0
	globalThis.cancelAnimationFrame = (id) => { cancelled = id }
	let el = box(1000, 600, 400)
	Object.assign(scroll.state, { el, frame: 7, gap: 0, forced: true })
	try {
		scroll.touchStart()
		expect(cancelled).toBe(7)
		expect(scroll.state.frame).toBe(0)
		// The reader has only moved 10px: still inside near-bottom range.
		el.scrollTop = 590
		scroll.follow(() => { el.scrollHeight += 100 }, 'jump')
		expect(el.scrollTop).toBe(590)
		scroll.touchEnd()
		// The reader now has a real gap; later output leaves them alone.
		scroll.follow(() => { el.scrollHeight += 100 }, 'jump')
		expect(el.scrollTop).toBe(590)
		// A deliberate send still takes them to the bottom.
		scroll.follow(() => {}, 'jump', true)
		expect(el.scrollTop).toBe(800)
	} finally {
		globalThis.cancelAnimationFrame = cancel
		Object.assign(scroll.state, original)
	}
})
