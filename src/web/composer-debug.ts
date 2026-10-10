/// <reference lib="dom" />
// Opt-in composer probe (config.ason composerDebug): every composer
// event with the full state the bug could hide in, posted to this
// host's state/composer-debug.log. Records draft text, so it is off by
// default. Anomalies (box and state disagree, the example drawn under
// typed text, mismatched fonts) are logged with a page badge.
import { app } from './app.ts'
import { strings } from '../common/strings.ts'

type Row = Record<string, unknown>
let rows: Row[] = [], timer: ReturnType<typeof setTimeout> | undefined, serial = 0, anomalies = 0, lastAnomaly = ''
const page = crypto.randomUUID().slice(0, 8)
let badge: HTMLElement | undefined

const rect = (el: Element | null | undefined) => {
	if (!el) return null
	let r = el.getBoundingClientRect()
	return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10)
}
const font = (el: Element | null | undefined) => {
	if (!el) return null
	let s = getComputedStyle(el)
	return { family: s.fontFamily, size: s.fontSize, letter: s.letterSpacing, pad: s.paddingLeft, opacity: s.opacity, visibility: s.visibility }
}
// One character's width in an element's font, so hint and box columns can be compared.
const chWidth = (el: Element | null | undefined) => {
	if (!el) return null
	let probe = document.createElement('span')
	probe.textContent = '0'.repeat(20)
	probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${getComputedStyle(el).font};letter-spacing:${getComputedStyle(el).letterSpacing}`
	document.body.append(probe)
	let w = probe.getBoundingClientRect().width / 20
	probe.remove()
	return Math.round(w * 1000) / 1000
}

function snapshot(): Row {
	let box = document.querySelector<HTMLTextAreaElement>('.Composer .field textarea:not(.measure)')
	let hint = document.querySelector<HTMLElement>('.Composer .entry .hint')
	let st = app.state, t = st.view.transcript, vv = visualViewport
	return {
		tab: st.shown, session: t?.meta.id, state: t?.state.type,
		stateText: st.text, value: box?.value, sel: box ? [box.selectionStart, box.selectionEnd, box.selectionDirection] : null,
		focused: document.activeElement === box, active: document.activeElement?.tagName, disabled: box?.disabled,
		hint: hint && { class: hint.className, cut: hint.querySelector('.cut')?.textContent, text: hint.querySelector('.text')?.textContent, rect: rect(hint), textRect: rect(hint.querySelector('.text')), font: font(hint), ch: chWidth(hint) },
		box: box && { rect: rect(box), client: [box.clientWidth, box.clientHeight], scroll: [box.scrollWidth, box.scrollHeight, box.scrollLeft, box.scrollTop], styleHeight: box.style.height, font: font(box), ch: chWidth(box) },
		field: rect(document.querySelector('.Composer .field')), entry: rect(document.querySelector('.Composer .entry')),
		attach: rect(document.querySelector('.Composer .attach')),
		actions: [...document.querySelectorAll<HTMLButtonElement>('.Composer .actions button')].map((b) => ({ label: b.getAttribute('aria-label'), rect: rect(b), disabled: b.disabled })),
		actionsClass: document.querySelector('.Composer .actions')?.className,
		vv: vv && [vv.width, vv.height, vv.offsetTop, vv.scale].map((n) => Math.round(n * 10) / 10), inner: [innerWidth, innerHeight], dpr: devicePixelRatio,
	}
}

// What the screenshot shows: the example drawn over typed text, or the box and state disagreeing.
function anomaly(s: Row): string[] {
	let out: string[] = []
	let value = (s.value as string | undefined) ?? '', hint = s.hint as { class: string; cut?: string; text?: string; font: { size: string; family: string; letter: string; pad: string } | null; ch: number | null } | null
	let box = s.box as { font: { size: string; family: string; letter: string; pad: string } | null; ch: number | null } | null
	if (s.value !== undefined && s.value !== s.stateText) out.push('box value differs from app.state.text')
	if (hint && value && !hint.class.split(' ').includes('gone') && hint.text && !value.includes('\n') && strings.visLen(hint.cut ?? '') < strings.visLen(value)) out.push('example drawn under typed text')
	if (hint?.font && box?.font && (hint.font.size !== box.font.size || hint.font.family !== box.font.family || hint.font.letter !== box.font.letter || hint.font.pad !== box.font.pad)) out.push('example and box fonts differ')
	if (hint?.ch && box?.ch && Math.abs(hint.ch - box.ch) > 0.01) out.push('example and box column widths differ')
	return out
}

function record(event: string, detail: Row = {}): void {
	let s = { n: ++serial, at: new Date().toISOString(), ms: Math.round(performance.now()), event, ...detail, ...snapshot() }
	let found = anomaly(s)
	if (found.length) {
		;(s as Row).anomaly = found
		let key = found.join('|')
		if (key !== lastAnomaly) anomalies++
		lastAnomaly = key
	} else lastAnomaly = ''
	rows.push(s)
	if (rows.length > 400) rows.splice(0, rows.length - 400)
	if (badge) badge.textContent = `composer debug ${serial}${anomalies ? ` · ${anomalies} anomal${anomalies === 1 ? 'y' : 'ies'}: ${found.join(', ') || 'last cleared'}` : ''}`
	if (badge) badge.dataset.bad = String(!!found.length)
	timer ??= setTimeout(flush, found.length ? 200 : 2000)
}

async function flush(): Promise<void> {
	timer = undefined
	if (!rows.length) return
	let batch = rows.splice(0, 100)
	try {
		let res = await fetch('/composer-debug', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', keepalive: batch.length < 20, body: JSON.stringify({ page, ua: navigator.userAgent, rows: batch }) })
		if (!res.ok) throw new Error(`HTTP ${res.status}`)
	} catch (error) {
		rows = [...batch, ...rows].slice(-400)
		if (badge) badge.textContent = `composer debug: upload failed: ${String(error)}`
	}
	if (rows.length) timer ??= setTimeout(flush, 2000)
}

function init(): void {
	badge = document.createElement('div')
	badge.className = 'ComposerDebug'
	badge.setAttribute('aria-hidden', 'true')
	badge.textContent = 'composer debug on'
	document.body.append(badge)
	let inBox = (e: Event) => e.target instanceof HTMLTextAreaElement && !!e.target.closest('.Composer .field') && !e.target.classList.contains('measure')
	let later = (name: string) => { setTimeout(() => record(`${name}+task`), 0); requestAnimationFrame(() => requestAnimationFrame(() => record(`${name}+frame`))) }
	for (let name of ['beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend', 'keydown', 'keyup', 'focus', 'blur', 'paste', 'cut', 'select']) {
		document.addEventListener(name, (e) => {
			if (!inBox(e)) return
			let d: Row = {}
			if (e instanceof InputEvent) Object.assign(d, { inputType: e.inputType, data: e.data, composing: e.isComposing })
			if (e instanceof CompositionEvent) d.data = e.data
			if (e instanceof KeyboardEvent) Object.assign(d, { key: e.key, code: e.code, keyCode: e.keyCode, composing: e.isComposing })
			record(name, d)
			if (name === 'input' || name === 'compositionend' || name === 'keyup') later(name)
		}, { capture: true, passive: true })
	}
	document.addEventListener('selectionchange', () => { if (document.activeElement?.closest('.Composer .field')) record('selectionchange') }, { passive: true })
	// Example and layout changes the events above don't cause (timers, host events, resizes).
	let watched = new WeakSet<Element>()
	// The example animates every few ms: record a change only if it shows a
	// fault or 250ms passed since the last one.
	let hintAt = 0
	let hintChanges = new MutationObserver(() => {
		let now = performance.now()
		if (now - hintAt < 250 && !anomaly(snapshot()).length) return
		hintAt = now
		record('hint-mutation')
	})
	let sizes = new ResizeObserver((entries) => record('resize', { targets: entries.map((e) => (e.target as HTMLElement).className) }))
	let attach = () => {
		for (let el of document.querySelectorAll('.Composer .entry, .Composer .field, .Composer .actions, .Composer .entry .hint')) {
			if (watched.has(el)) continue
			watched.add(el)
			if (el.classList.contains('hint')) hintChanges.observe(el, { attributes: true, characterData: true, childList: true, subtree: true })
			else sizes.observe(el)
		}
	}
	let queued = false
	new MutationObserver(() => { if (!queued) { queued = true; queueMicrotask(() => { queued = false; attach() }) } }).observe(document.body, { childList: true, subtree: true })
	attach()
	visualViewport?.addEventListener('resize', () => record('vv-resize'))
	document.addEventListener('visibilitychange', () => { record(`visibility-${document.visibilityState}`); if (document.visibilityState === 'hidden') void flush() })
	// A disagreement can appear without any composer event (a host event resets the text).
	setInterval(() => { let s = snapshot(); if (anomaly(s).length) record('poll') }, 1000)
	record('start', { ua: navigator.userAgent })
}

export const composerDebug = { init }
