import { expect, test } from 'bun:test'
import { scroll } from './scroll.ts'

const box = (scrollHeight: number, scrollTop: number, clientHeight: number) => ({
	scrollHeight,
	scrollTop,
	clientHeight,
})

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
	Object.assign(scroll.state, { el, pinned: true, finger: false })
	try {
		scroll.follow(() => {
			el.scrollHeight += 100
		})
		expect(el.scrollTop).toBe(700)
		scroll.state.finger = true
		el.scrollTop = 690
		scroll.check('scroll')
		scroll.follow(() => {
			el.scrollHeight += 100
		})
		expect(el.scrollTop).toBe(690)
		scroll.follow(() => {}, true)
		expect(el.scrollTop).toBe(800)
		// A viewport/composer resize corrects the bottom immediately.
		el.clientHeight = 380
		scroll.check('resize')
		expect(el.scrollTop).toBe(820)
		// The reader scrolls away, then back to the bottom: following again.
		el.scrollTop = 810
		scroll.check('scroll')
		expect(scroll.state.pinned).toBe(false)
		el.scrollTop = 820
		scroll.check('scroll')
		expect(scroll.state.pinned).toBe(true)
		scroll.follow(() => {
			el.scrollHeight += 100
		})
		expect(el.scrollTop).toBe(920)
	} finally {
		Object.assign(scroll.state, original)
	}
})

test('after the finger lifts, nothing but the reader changes following', () => {
	let original = { ...scroll.state }
	let el = box(4360, 2357, 622)
	Object.assign(scroll.state, { el, pinned: false, finger: false, input: -Infinity })
	try {
		// Momentum or a layout jump reaches the bottom: still not following.
		el.scrollTop = 3738
		scroll.check('scroll')
		expect(scroll.state.pinned).toBe(false)
		scroll.follow(() => {
			el.scrollHeight += 200
		})
		expect(el.scrollTop).toBe(3738)
		// Following: momentum or layout leaving the bottom keeps it.
		scroll.follow(() => {}, true)
		el.scrollTop -= 50
		scroll.check('scroll')
		expect(scroll.state.pinned).toBe(true)
	} finally {
		Object.assign(scroll.state, original)
	}
})

test('content shrinking to the bottom never resumes following for a reader', () => {
	let original = { ...scroll.state }
	let el = box(1000, 300, 400)
	Object.assign(scroll.state, { el, pinned: false })
	try {
		el.scrollHeight = 700
		scroll.check('content')
		expect(scroll.state.pinned).toBe(false)
		scroll.check('scroll')
		expect(scroll.state.pinned).toBe(false)
		scroll.check('resize')
		scroll.follow(() => {
			el.scrollHeight += 500
		})
		expect(el.scrollTop).toBe(300)
		expect(scroll.state.pinned).toBe(false)
	} finally {
		Object.assign(scroll.state, original)
	}
})

test('input without movement and layout clamps preserve following', () => {
	let original = { ...scroll.state },
		el = box(1000, 600, 400)
	Object.assign(scroll.state, { el, pinned: true, held: undefined, finger: true })
	try {
		scroll.follow(() => {
			el.scrollHeight += 200
		})
		expect(el.scrollTop).toBe(800)
		el.scrollHeight -= 100
		el.scrollTop = 700
		scroll.check('scroll')
		scroll.follow(() => {
			el.scrollHeight += 200
		})
		expect(el.scrollTop).toBe(900)
		expect(scroll.state.pinned).toBe(true)
	} finally {
		Object.assign(scroll.state, original)
	}
})

test('forced bottom navigation releases a linked-card anchor', () => {
	let original = { ...scroll.state },
		el = box(1000, 200, 400)
	let card = { isConnected: true, getBoundingClientRect: () => ({ top: 200 - el.scrollTop }) } as Element
	Object.assign(scroll.state, { el, pinned: false, held: undefined })
	try {
		scroll.hold(card)
		scroll.follow(() => {}, true)
		scroll.check('content')
		expect(el.scrollTop).toBe(600)
		expect(scroll.state.held).toBeUndefined()
	} finally {
		Object.assign(scroll.state, original)
	}
})

test('link navigation follows only when it lands at the bottom', () => {
	let original = { ...scroll.state },
		el = box(1000, 200, 400)
	let card = { isConnected: true, getBoundingClientRect: () => ({ top: 200 - el.scrollTop }) } as Element
	Object.assign(scroll.state, { el, pinned: true, held: undefined })
	try {
		scroll.hold(card)
		scroll.moved()
		expect(scroll.state.pinned).toBe(false)
		expect(scroll.state.held?.card).toBe(card)
		el.scrollTop = 599.5
		scroll.hold(card)
		scroll.moved()
		expect(scroll.state.pinned).toBe(true)
		expect(scroll.state.held).toBeUndefined()
		scroll.follow(() => {
			el.scrollHeight += 100
		})
		expect(el.scrollTop).toBe(700)
	} finally {
		Object.assign(scroll.state, original)
	}
})

test('a wheel event delivered after its scroll still releases following', () => {
	let original = { ...scroll.state },
		el = box(1000, 600, 400)
	Object.assign(scroll.state, { el, top: 600, pinned: true, finger: false, input: -Infinity })
	try {
		el.scrollTop = 480
		scroll.check('scroll')
		scroll.state.input = performance.now()
		scroll.check('scroll')
		scroll.follow(() => {
			el.scrollHeight += 200
		})
		expect(el.scrollTop).toBe(480)
		expect(scroll.state.pinned).toBe(false)
	} finally {
		Object.assign(scroll.state, original)
	}
})
