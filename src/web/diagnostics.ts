/// <reference lib="dom" />
// Best-effort HTTP diagnostics still work when the WebSocket does not.
// Only fixed labels and numeric/boolean state; no text or persistent storage.
import { diagnosticDetails, type Breadcrumb, type DiagnosticContext, type DiagnosticKind } from '../common/web-diagnostics.ts'

let entries: Breadcrumb[] = [], read: (() => DiagnosticContext) | undefined
let lag = 0
let page = '', timer: ReturnType<typeof setTimeout> | undefined, busy = false, last = 0
function record(kind: DiagnosticKind, detail: string = 'other', line?: number, column?: number): void {
	if (!read) return
	let e: Breadcrumb = { at: Date.now(), kind, detail: diagnosticDetails.includes(detail as any) ? detail as Breadcrumb['detail'] : 'other' }
	if (Number.isFinite(line) && line! >= 0) e.line = line
	if (Number.isFinite(column) && column! >= 0) e.column = column
	let prev = entries.at(-1)
	if (kind === 'event' && prev?.kind === kind && prev.detail === e.detail) entries[entries.length - 1] = e
	else { entries.push(e); if (entries.length > 32) entries.shift() }
}

function report(): void {
	if (!read || timer || busy || !entries.length) return
	timer = setTimeout(() => {
		timer = undefined
		void send()
	}, Math.max(250, last + 5000 - Date.now()))
}

async function send(): Promise<void> {
	if (!read || busy || !entries.length) return
	busy = true; last = Date.now()
	let batch = entries.splice(0)
	try {
		let body = JSON.stringify({ page, version: document.documentElement.dataset.version ?? 'unknown', at: Date.now(), context: { ...read(), lag }, entries: batch })
		let res = await fetch('/web-diagnostics', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body, keepalive: true, signal: AbortSignal.timeout(10_000) })
		// A rejected report would be rejected again: drop it.
		if (!res.ok && res.status !== 400) throw new Error('not accepted')
	} catch { entries = [...batch, ...entries].slice(-32) }
	finally { busy = false }
}

function init(context: () => DiagnosticContext): void {
	if (read) return
	read = context
	page = crypto.randomUUID().replaceAll('-', '')
	let failure = (kind: 'error' | 'rejection', error: unknown, line?: number, column?: number) => {
		// Never stringify the error/rejection: messages can contain user data.
		let name = error instanceof Error ? error.name : 'other'
		record(kind, name, line, column); report()
	}
	window.addEventListener('error', (e) => failure('error', e.error, e.lineno, e.colno))
	window.addEventListener('unhandledrejection', (e) => failure('rejection', e.reason))
	let area = (e: Event): string => {
		let el = e.target instanceof Element ? e.target : undefined
		return el?.closest('.Tabs') ? 'tabs' : el?.closest('.Composer') ? 'composer' : el?.closest('.Card') ? 'card' : 'other'
	}
	for (let name of ['pointerdown', 'click'] as const) document.addEventListener(name, (e) => {
		let detail = area(e)
		if (detail === 'other') return
		record(name === 'click' ? 'click' : 'pointer', detail)
		if (name === 'click') { let start = performance.now(); setTimeout(() => { lag = Math.max(0, Math.round(performance.now() - start)); record('settled', detail); report() }, 0) }
	}, { capture: true, passive: true })
	// A character typed while focus is anywhere but the message box:
	// where focus was, then whether the key reached the box. Capture on
	// window sees it even if a handler stops it. Never which key.
	let box = (el: Element | null) => el instanceof HTMLTextAreaElement && !!el.closest('.Composer')
	let focusArea = (el: Element | null): string =>
		!el || el === document.body ? 'body' : el.closest('dialog[open]') ? 'dialog' : el.matches('input, textarea, select, [contenteditable]') ? 'field'
			: el.closest('.Tabs') ? 'tabs' : el.closest('.Card') ? 'card' : el instanceof HTMLButtonElement ? 'button' : el instanceof HTMLAnchorElement ? 'link' : 'other'
	addEventListener('keydown', (e: KeyboardEvent) => {
		if ([...e.key].length !== 1 || e.ctrlKey || e.altKey || e.metaKey || e.isComposing || box(document.activeElement)) return
		record('key', focusArea(document.activeElement))
		setTimeout(() => { record('settled', box(document.activeElement) ? 'composer' : 'other'); report() }, 0)
	}, { capture: true, passive: true })
	document.addEventListener('visibilitychange', () => { record('visibility', document.visibilityState); report() })
	addEventListener('pageshow', () => { record('pageshow'); report() })
	addEventListener('focus', () => { record('focus'); report() })
	record('start'); report()
}

export const diagnostics = { init: (context: () => DiagnosticContext) => { try { init(context) } catch { read = undefined } }, record, report }
