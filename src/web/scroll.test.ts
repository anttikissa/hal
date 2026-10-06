import { expect, test } from 'bun:test'
import { scroll } from './scroll.ts'

const box = (scrollHeight: number, scrollTop: number, clientHeight: number) => ({ scrollHeight, scrollTop, clientHeight })

test('each tab keeps its place: a bottom reader returns to the (grown) bottom, others to their spot', () => {
	let el = box(1000, 600, 400)
	scroll.state.el = el
	try {
		scroll.save('1-aaa')
		// The reader scrolls up by hand: no longer pinned.
		scroll.state.pinned = false
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

test('following is immediate; a reader leaving even 10px is not pulled back', () => {
	let original = { ...scroll.state }
	let el = box(1000, 600, 400)
	Object.assign(scroll.state, { el, pinned: true, touching: false, pressing: false })
	try {
		scroll.follow(() => { el.scrollHeight += 100 })
		expect(el.scrollTop).toBe(700)
		scroll.touchStart()
		el.scrollTop = 690
		scroll.follow(() => { el.scrollHeight += 100 })
		expect(el.scrollTop).toBe(690)
		scroll.touchEnd()
		scroll.follow(() => { el.scrollHeight += 100 })
		expect(el.scrollTop).toBe(690)
		scroll.follow(() => {}, true)
		expect(el.scrollTop).toBe(900)
		// A viewport/composer resize corrects the bottom immediately.
		el.clientHeight = 380
		scroll.check('resize')
		expect(el.scrollTop).toBe(920)
		// Reader scrolls back to bottom and resumes following.
		scroll.leave()
		scroll.check('scroll', true)
		expect(scroll.state.pinned).toBe(true)
		scroll.follow(() => { el.scrollHeight += 100 })
		expect(el.scrollTop).toBe(1020)
	} finally {
		Object.assign(scroll.state, original)
	}
})
