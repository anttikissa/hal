/// <reference lib="dom" />
// Opt-in scroll probe (config.ason scrollDebug): why the transcript
// moved. It logs every write to the transcript's scroll position with
// the code path that made it (scroll.note), scroll events (at most one per
// 100 ms) and jumps: rows moving in the content (a layout change above
// them), or the view moving over a screen at once with no finger down.
// The log survives reloads in localStorage (an iOS reload can be the
// jump); /scroll-log asks the page to post it to the host's
// state/scroll-debug.log. Numbers and row keys only, no text.
import { scroll } from './scroll.ts'

type Row = Record<string, unknown>
const store = 'hal.scrollLog'
const page = crypto.randomUUID().slice(0, 8)
let rows: Row[] = [],
	on = false,
	touching = false,
	why: string | undefined,
	wrote = 0,
	saving: ReturnType<typeof setTimeout> | undefined

// Where the view is: scrollTop, the space above the rows, the first
// mounted row and the row at the view's center with its content offset.
function where(): Row {
	let el = scroll.state.el
	if (!el) return {}
	let box = el.getBoundingClientRect()
	let center = document
		.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
		?.closest<HTMLElement>('[data-scroll-key]')
	return {
		st: Math.round(el.scrollTop),
		sh: el.scrollHeight,
		ch: el.clientHeight,
		pad: Math.round(scroll.state.pad),
		first: el.querySelector<HTMLElement>('.rows > [data-scroll-key]')?.dataset.scrollKey,
		key: center?.dataset.scrollKey,
		y: center && Math.round(center.getBoundingClientRect().top - box.top + el.scrollTop),
		moving: scroll.state.moving?.(),
		touching,
	}
}

function record(what: string, detail?: Row): void {
	let row = { page, at: Date.now(), t: Math.round(performance.now()), what, why, ...detail, ...where() }
	let prev = rows.at(-1)
	// A repeat (live follow while streaming) counts on its last row.
	if (prev?.what === what && prev.why === why && !detail && row.at - (prev.at as number) < 1000)
		rows[rows.length - 1] = { ...row, n: ((prev.n as number) ?? 1) + 1 }
	else rows.push(row)
	if (rows.length > 5000) rows.splice(0, rows.length - 5000)
	saving ??= setTimeout(save, 1000)
}

function save(): void {
	clearTimeout(saving)
	saving = undefined
	try {
		localStorage.setItem(store, JSON.stringify(rows))
	} catch (error) {
		rows.push({ page, at: Date.now(), what: 'save failed', error: String(error) })
	}
}

// The first frames of the stack that called a scroll write.
function stack(): string | undefined {
	return new Error().stack
		?.split('\n')
		.slice(3, 6)
		.map((line) => line.replace(/\(?https?:\/\/[^)\s]*/g, '').trim())
		.join(' < ')
}

// Catches every scroll write on the transcript and the document, so
// writes no scroll.note names still show.
function catchWrites(): void {
	let mine = (el: unknown) => el === scroll.state.el
	let top = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!
	Object.defineProperty(Element.prototype, 'scrollTop', {
		...top,
		set(this: Element, v: number) {
			let from = mine(this) ? Math.round(top.get!.call(this)) : undefined
			top.set!.call(this, v)
			if (from !== undefined) {
				wrote = performance.now()
				record('write', { from, to: Math.round(v), stack: stack() })
			}
		},
	})
	for (let name of ['scrollTo', 'scrollBy', 'scrollIntoView'] as const) {
		let f = Element.prototype[name] as (...a: unknown[]) => void
		Element.prototype[name] = function (this: Element, ...a: unknown[]) {
			let hit = name === 'scrollIntoView' ? !!scroll.state.el?.contains(this) : mine(this)
			let from = hit ? Math.round(scroll.state.el!.scrollTop) : undefined
			f.apply(this, a)
			if (hit) {
				wrote = performance.now()
				record(name, { from, args: JSON.stringify(a), stack: stack() })
			}
		} as never
	}
	let windowTo = window.scrollTo.bind(window) as (...a: unknown[]) => void
	window.scrollTo = ((...a: unknown[]) => {
		record('window.scrollTo', { args: JSON.stringify(a), scrollY, stack: stack() })
		windowTo(...a)
	}) as never
}

function watch(): void {
	let last: Row = {},
		lastAt = 0
	let check = (event: string) => {
		let now = where()
		let same = now.key !== undefined && now.key === last.key
		let dy = same ? (now.y as number) - (last.y as number) : 0
		if (same && Math.abs(dy) > 2) record('SHIFT', { event, dy })
		else if (
			!touching &&
			last.st !== undefined &&
			Math.abs((now.st as number) - (last.st as number)) > (now.ch as number)
		)
			// sinceWrite: a large value means the browser moved the view, not code.
			record('JUMP', { event, from: last.st, sinceWrite: Math.round(performance.now() - wrote) })
		else if (event === 'scroll' && performance.now() - lastAt > 100) {
			lastAt = performance.now()
			record('scroll')
		}
		last = now
	}
	document.addEventListener('scroll', (e) => e.target === scroll.state.el && check('scroll'), {
		capture: true,
		passive: true,
	})
	// Rows can move with no scroll event (a layout change above them).
	setInterval(() => check('poll'), 250)
	let finger = (down: boolean) => () => {
		touching = down
		record(down ? 'touch' : 'lift')
	}
	document.addEventListener('touchstart', finger(true), { capture: true, passive: true })
	document.addEventListener('touchend', finger(false), { capture: true, passive: true })
	document.addEventListener('touchcancel', finger(false), { capture: true, passive: true })
	// Focusing an element scrolls it into view.
	document.addEventListener('focusin', (e) => record('focus', { tag: (e.target as Element).tagName }))
	document.addEventListener('visibilitychange', () => {
		record(document.visibilityState)
		if (document.visibilityState === 'hidden') save()
	})
	addEventListener('pagehide', save)
}

function init(): void {
	on = true
	try {
		rows = JSON.parse(localStorage.getItem(store) ?? '[]')
	} catch {
		rows = []
	}
	scroll.state.note = (what) => {
		why = why ? `${why}>${what}` : what
		record(what)
		queueMicrotask(() => (why = undefined))
	}
	catchWrites()
	watch()
	record('start', { ua: navigator.userAgent, w: innerWidth, h: innerHeight })
}

// Posts the whole log in batches of 100 rows (the host's limit).
async function send(): Promise<void> {
	if (!on) return
	record('send')
	let batch = rows.splice(0)
	for (let i = 0; i < batch.length; i += 100) {
		try {
			let res = await fetch('/scroll-debug', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ page, ua: navigator.userAgent, rows: batch.slice(i, i + 100) }),
			})
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
		} catch (error) {
			rows = [...batch.slice(i), ...rows]
			record('send failed', { error: String(error) })
			break
		}
	}
	save()
}

export const scrollDebug = { init, send }
