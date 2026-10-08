/// <reference lib="dom" />
// Page-local, explicit touch probe. No telemetry or user text.
import { app } from './app.ts'
import { router } from './router.ts'

let stop: (() => void) | undefined

function start(): void {
	if (stop) return
	let panel = document.createElement('pre'), mark = document.createElement('span')
	panel.className = 'TouchDebug'
	mark.className = 'TouchCrosshair'
	panel.setAttribute('aria-hidden', 'true')
	mark.setAttribute('aria-hidden', 'true')
	panel.textContent = 'Touch debug ON — tap Send'
	document.body.append(panel, mark)
	let rows: string[] = [], serial = 0
	let label = (target: EventTarget | null) => {
		let el = target instanceof Element ? target : null
		let action = el?.closest('.Composer button')?.getAttribute('aria-label')
		if (action && ['Send', 'Steer', 'Queue', 'Run', 'Pause (Esc)', 'Continue', 'Attach file', 'Save queued message'].includes(action)) return action
		let n = el?.closest('.Tabs a.tab')?.querySelector('.n')?.textContent
		if (n && /^\d+$/.test(n)) return `tab:${Number(n)}`
		return el?.closest('.Composer textarea') ? 'draft' : el?.closest('.Composer') ? 'composer' : el?.closest('.Tabs') ? 'tabs' : el?.closest('.Transcript') ? 'transcript' : 'other'
	}
	let selection = () => {
		let number = (id: string | undefined) => app.state.tabs.findIndex(t => t.id === id) + 1
		let rendered = Number(document.querySelector('.Tabs .strip [aria-current] .n')?.textContent) || 0
		return `tab:${number(app.state.shown)} url:${number(router.parse(location.href))} dom:${rendered}`
	}
	let record = (name: string, target: string, canceled: boolean, point?: { clientX: number; clientY: number; pageX: number; pageY: number }, state = '') => {
		let vv = visualViewport, box = document.querySelector('.Composer .go')?.getBoundingClientRect()
		let xy = point ? ` c${Math.round(point.clientX)},${Math.round(point.clientY)} p${Math.round(point.pageX)},${Math.round(point.pageY)}` : ''
		rows.push(`${++serial} ${name} ${target}${xy}${canceled ? ' prevented' : ''}${state}`)
		if (rows.length > 8) rows.shift()
		panel.textContent = `TOUCH DEBUG — menu to stop\n${selection()}\nfocus:${label(document.activeElement)} vv:${Math.round(vv?.height ?? innerHeight)} top:${Math.round(vv?.offsetTop ?? 0)} scroll:${Math.round(scrollY)}\nsend:${box ? [box.left, box.top, box.right, box.bottom].map(Math.round).join(',') : 'absent'}\n${rows.join('\n')}`
	}
	let event = (e: Event) => {
		let point = typeof TouchEvent !== 'undefined' && e instanceof TouchEvent ? e.changedTouches[0] : e instanceof MouseEvent ? e : undefined
		if (e.type === 'touchstart' && point) {
			mark.style.left = `${point.pageX}px`
			mark.style.top = `${point.pageY}px`
			mark.classList.add('visible')
		}
		// Read cancellation after the component handlers, not before them.
		let target = label(e.target)
		let button = document.querySelector<HTMLButtonElement>('.Composer .go')
		let rect = button?.getBoundingClientRect()
		let state = ` @${Math.round(e.timeStamp)} ${selection()} f:${label(document.activeElement)} d:${Number(!!button?.disabled)} y:${Math.round(rect?.top ?? 0)} v:${Math.round(visualViewport?.height ?? innerHeight)}`
		let xy = point && { clientX: point.clientX, clientY: point.clientY, pageX: point.pageX, pageY: point.pageY }
		setTimeout(() => { if (panel.isConnected) record(e.type, target, e.defaultPrevented, xy, state) }, 0)
	}
	let failure = (kind: string, error: unknown, line = 0, column = 0) => {
		let name = error instanceof Error || error instanceof DOMException ? error.name : 'other'
		if (!['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'SecurityError', 'InvalidStateError', 'QuotaExceededError'].includes(name)) name = 'other'
		record(kind, name, false, undefined, ` line:${line} col:${column}`)
	}
	let error = (e: ErrorEvent) => failure('error', e.error, e.lineno, e.colno)
	let rejection = (e: PromiseRejectionEvent) => failure('rejection', e.reason)
	window.addEventListener('error', error)
	window.addEventListener('unhandledrejection', rejection)
	let names = ['touchstart', 'touchend', 'touchcancel', 'pointerdown', 'pointerup', 'pointercancel', 'click', 'focusin', 'focusout']
	for (let name of names) window.addEventListener(name, event, { capture: true, passive: true })
	let resized = () => record('vv-resize', 'viewport', false)
	let scrolled = () => record('vv-scroll', 'viewport', false)
	visualViewport?.addEventListener('resize', resized)
	visualViewport?.addEventListener('scroll', scrolled)
	stop = () => {
		for (let name of names) window.removeEventListener(name, event, true)
		visualViewport?.removeEventListener('resize', resized)
		visualViewport?.removeEventListener('scroll', scrolled)
		window.removeEventListener('error', error)
		window.removeEventListener('unhandledrejection', rejection)
		panel.remove(); mark.remove()
		stop = undefined
	}
}

export const touchDebug = { start, stop: () => stop?.() }
