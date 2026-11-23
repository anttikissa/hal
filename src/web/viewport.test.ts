import { expect, test } from 'bun:test'
import { viewport } from './viewport.ts'

test('the page follows the visual viewport as the keyboard opens, until stopped; without one nothing is written', () => {
	let listeners = new Map<string, () => void>()
	let source = {
		width: 390,
		height: 800,
		offsetLeft: 0,
		offsetTop: 0,
		addEventListener: (type: string, f: () => void) => void listeners.set(type, f),
		removeEventListener: (type: string, f: () => void) => void (listeners.get(type) === f && listeners.delete(type)),
	}
	let css: Record<string, string> = {}
	let stop = viewport.sync(source, { setProperty: (k: string, v: string | null) => void (css[k] = v ?? '') })
	expect(css).toEqual({ '--app-width': '390px', '--app-height': '800px', '--app-left': '0px', '--app-top': '0px' })
	// The keyboard shrinks the viewport, then Safari pans it down.
	source.height = 450
	listeners.get('resize')!()
	source.offsetTop = 120
	listeners.get('scroll')!()
	expect(css).toEqual({ '--app-width': '390px', '--app-height': '450px', '--app-left': '0px', '--app-top': '120px' })
	// Pinching/panning while typing changes width too: the app follows the
	// visible rectangle so the composer stays on screen.
	source.width = 195
	source.height = 225
	source.offsetLeft = 90
	listeners.get('resize')!()
	listeners.get('scroll')!()
	expect(css).toEqual({ '--app-width': '195px', '--app-height': '225px', '--app-left': '90px', '--app-top': '120px' })
	stop()
	expect(listeners.size).toBe(0)
	let written = 0
	viewport.sync(undefined, { setProperty: () => void written++ })()
	expect(written).toBe(0)
})

test('a stale keyboard-height visual viewport yields to the layout one while no field could hold a keyboard', () => {
	let noop = () => {}
	let source = {
		width: 393,
		height: 485,
		offsetLeft: 0,
		offsetTop: 0,
		addEventListener: noop,
		removeEventListener: noop,
	}
	let focus: (() => void) | undefined
	let resume = { addEventListener: (_: string, f: () => void) => void (focus = f), removeEventListener: noop }
	let typing = true
	let css: Record<string, string> = {}
	viewport.sync(
		source,
		{ setProperty: (k: string, v: string | null) => void (css[k] = v ?? '') },
		() => (typing ? undefined : { width: 393, height: 793, offsetLeft: 0, offsetTop: 0 }),
		[[resume, ['focusout']]],
	)
	expect(css['--app-height']).toBe('485px')
	// The stale viewport fires nothing; the focus change re-reads it.
	typing = false
	focus!()
	expect(css['--app-height']).toBe('793px')
})

test('statusTap ignores scrollY=0 while settling after blur or resize, and fires after', () => {
	let emitter = () => {
		let map = new Map<string, Set<() => void>>()
		return {
			addEventListener: (t: string, f: () => void) => (map.get(t) ?? map.set(t, new Set()).get(t)!).add(f),
			removeEventListener: (t: string, f: () => void) => void map.get(t)?.delete(f),
			emit: (t: string) => map.get(t)?.forEach((f) => f()),
		}
	}
	let g = globalThis as Record<string, unknown>
	let keys = ['window', 'document', 'visualViewport', 'scrollY', 'scrollTo', 'requestAnimationFrame', 'setTimeout']
	let saved = Object.fromEntries(keys.map((k) => [k, g[k]]))
	let savedNow = performance.now
	let now = 1000
	let win = emitter(),
		vv = emitter(),
		classes = new Set<string>(),
		doc = Object.assign(emitter(), {
			activeElement: null as { matches: (s: string) => boolean } | null,
			documentElement: {
				classList: {
					contains: (c: string) => classes.has(c),
					toggle: (c: string, on?: boolean) => (on ? classes.add(c) : classes.delete(c)),
					remove: (c: string) => classes.delete(c),
				},
			},
		})
	let timers: (() => void)[] = []
	try {
		performance.now = () => now
		g.window = win
		g.document = doc
		g.visualViewport = vv
		g.scrollY = 1
		g.scrollTo = (_x: number, y: number) => void (g.scrollY = y)
		g.requestAnimationFrame = (f: () => void) => (f(), 0)
		g.setTimeout = (f: () => void) => (timers.push(f), 0)
		let tops = 0
		let stop = viewport.statusTap(() => tops++)
		// Typing in composer, then Send blurs it (no focused input) and closes keyboard.
		doc.activeElement = { matches: (s) => s.includes('textarea') }
		doc.emit('focusin')
		now += 1000
		doc.activeElement = null
		doc.emit('focusout')
		// Immediately after blur (before setTimeout(focus)) and 450 ms later (during keyboard close).
		g.scrollY = 0
		win.emit('scroll')
		timers.splice(0).forEach((f) => f())
		now += 450
		g.scrollY = 0
		win.emit('scroll')
		expect(tops).toBe(0)
		// Viewport resize extends the quiet window by another 600 ms.
		vv.emit('resize')
		now += 500
		g.scrollY = 0
		win.emit('scroll')
		expect(tops).toBe(0)
		// Once settled, a status-bar tap reaching scrollY 0 triggers top().
		now += 200
		g.scrollY = 0
		win.emit('scroll')
		expect(tops).toBe(1)
		// While an input is focused, scrollY=0 never triggers top(), even past quietUntil.
		doc.activeElement = { matches: (s) => s.includes('textarea') }
		doc.emit('focusin')
		now += 1000
		g.scrollY = 0
		win.emit('scroll')
		expect(tops).toBe(1)
		stop()
	} finally {
		performance.now = savedNow
		for (let k of keys) {
			if (saved[k] === undefined) delete g[k]
			else g[k] = saved[k]
		}
	}
})
