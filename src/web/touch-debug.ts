/// <reference lib="dom" />
// Page-local, explicit touch probe. No telemetry or user text.
import { app } from './app.ts'
import { router } from './router.ts'

let stop: (() => void) | undefined
const KEY = 'hal.touch-debug.log'
let history: string[] | undefined
let saving: ReturnType<typeof setTimeout> | undefined
let storageError = ''

function load(): string[] {
	if (history) return history
	let stored = localStorage.getItem(KEY)
	let rows: unknown = stored === null ? [] : JSON.parse(stored)
	if (!Array.isArray(rows) || rows.length > 300 || !rows.every(row => typeof row === 'string' && row.length <= 2048)) throw new Error(`${KEY}: invalid touch debug history`)
	return history = rows
}

function persist(): void {
	clearTimeout(saving)
	saving = undefined
	try {
		localStorage.setItem(KEY, JSON.stringify(history))
		storageError = ''
	} catch (error) {
		let message = `${KEY}: ${String(error)}\nTouch logs remain in memory but could not be saved.`
		let changed = storageError !== message
		storageError = message
		if (changed) alert(message)
	}
}

function retain(row: string): void {
	let rows = load()
	rows.push(`${new Date().toISOString()} ${row}`)
	if (rows.length > 300) rows.shift()
	if (saving === undefined) saving = setTimeout(persist, 250)
}

function inspect(): void {
	let rows: string[]
	try { rows = load() } catch (error) { alert(String(error)); return }
	let dialog = document.createElement('dialog'), top = document.createElement('div'), title = document.createElement('h2'), text = document.createElement('pre')
	dialog.className = 'TouchHistory StatusDetails'
	dialog.setAttribute('aria-label', 'Touch debug logs')
	top.className = 'top'
	title.textContent = 'Touch debug logs'
	text.textContent = `${storageError ? `${storageError}\n\n` : ''}Stored only in this browser. Latest 300 events; recording is opt-in.\n\n${rows.join('\n\n') || 'No recorded events.'}`
	let paste = document.createElement('button'), clear = document.createElement('button'), close = document.createElement('button')
	paste.textContent = 'Paste logs'
	paste.disabled = !rows.length
	paste.onclick = () => {
		let logs = load().join('\n\n')
		if (!logs) return
		app.input(`${app.state.text}${app.state.text ? '\n\n' : ''}Touch debug logs:\n${logs}`)
		dialog.close()
	}
	clear.textContent = 'Clear logs'
	clear.onclick = () => {
		try { localStorage.removeItem(KEY) } catch (error) { alert(`${KEY}: ${String(error)}`); return }
		clearTimeout(saving); saving = undefined
		history = []; storageError = ''
		paste.disabled = true
		text.textContent = 'No recorded events.'
	}
	close.textContent = 'Close'
	close.onclick = () => dialog.close()
	top.append(title, paste, clear, close)
	dialog.append(top, text)
	dialog.addEventListener('close', () => dialog.remove(), { once: true })
	document.body.append(dialog)
	dialog.showModal()
}

function start(): void {
	if (stop) return
	try { load() } catch (error) { alert(String(error)); throw error }
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
	let caret = () => {
		let box = document.querySelector<HTMLTextAreaElement>('.Composer textarea')
		return box ? `caret:${box.selectionStart},${box.selectionEnd} draftScroll:${Math.round(box.scrollTop)}` : 'caret:absent'
	}
	let record = (name: string, target: string, canceled: boolean, point?: { clientX: number; clientY: number; pageX: number; pageY: number }, state = '', geometry = '') => {
		let vv = visualViewport, box = document.querySelector('.Composer .go')?.getBoundingClientRect()
		let xy = point ? ` c${Math.round(point.clientX)},${Math.round(point.clientY)} p${Math.round(point.pageX)},${Math.round(point.pageY)}` : ''
		rows.push(`${++serial} ${name} ${target}${xy}${canceled ? ' prevented' : ''}${state}`)
		if (rows.length > 8) rows.shift()
		let after = `${selection()} ${caret()} focus:${label(document.activeElement)} vv:${Math.round(vv?.height ?? innerHeight)} top:${Math.round(vv?.offsetTop ?? 0)} scroll:${Math.round(scrollY)} send:${box ? [box.left, box.top, box.right, box.bottom].map(Math.round).join(',') : 'absent'}`
		retain(`${rows.at(-1)}${geometry}\nafter ${after}`)
		panel.textContent = `TOUCH DEBUG — menu to stop\n${after}\n${rows.join('\n')}`
	}
	let pending = new Map<ReturnType<typeof setTimeout>, () => void>()
	let drain = () => {
		for (let [timer, observe] of pending) { clearTimeout(timer); observe() }
		pending.clear()
	}
	let flush = () => { drain(); persist() }
	let hidden = () => { if (document.visibilityState === 'hidden') flush() }
	window.addEventListener('pagehide', flush)
	document.addEventListener('visibilitychange', hidden)
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
		let state = ` @${Math.round(e.timeStamp)} ${selection()} ${caret()} f:${label(document.activeElement)} d:${Number(!!button?.disabled)} y:${Math.round(rect?.top ?? 0)} v:${Math.round(visualViewport?.height ?? innerHeight)}`
		let geometry = ` send:${rect ? [rect.left, rect.top, rect.right, rect.bottom].map(Math.round).join(',') : 'absent'} top:${Math.round(visualViewport?.offsetTop ?? 0)} scroll:${Math.round(scrollY)}`
		let xy = point && { clientX: point.clientX, clientY: point.clientY, pageX: point.pageX, pageY: point.pageY }
		let observe = () => record(e.type, target, e.defaultPrevented, xy, state, geometry)
		let timer = setTimeout(() => { pending.delete(timer); observe() }, 0)
		pending.set(timer, observe)
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
	let names = ['touchstart', 'touchend', 'touchcancel', 'pointerdown', 'pointerup', 'pointercancel', 'click', 'focusin', 'focusout', 'selectionchange']
	for (let name of names) window.addEventListener(name, event, { capture: true, passive: true })
	let resized = () => record('vv-resize', 'viewport', false)
	let scrolled = () => record('vv-scroll', 'viewport', false)
	visualViewport?.addEventListener('resize', resized)
	visualViewport?.addEventListener('scroll', scrolled)
	stop = () => {
		flush()
		window.removeEventListener('pagehide', flush)
		document.removeEventListener('visibilitychange', hidden)
		for (let name of names) window.removeEventListener(name, event, true)
		visualViewport?.removeEventListener('resize', resized)
		visualViewport?.removeEventListener('scroll', scrolled)
		window.removeEventListener('error', error)
		window.removeEventListener('unhandledrejection', rejection)
		panel.remove(); mark.remove()
		stop = undefined
	}
}

export const touchDebug = { start, stop: () => stop?.(), inspect }
