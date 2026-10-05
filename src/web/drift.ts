/// <reference lib="dom" />
// Temporary probe (task s0): spots the transcript leaving the bottom
// without the reader scrolling, logs it to diagnostics and shows a
// notice. Removable: delete this file, its line in main.tsx and the
// 'drift' kind. On while webDiagnostics is on. Breadcrumb: detail is
// the page visibility then, line the gap now, column the gap at the
// last check (px).
import { notices } from '../common/notices.ts'
import { app } from './app.ts'
import { diagnostics } from './diagnostics.ts'
import { scroll } from './scroll.ts'

const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

function init(): void {
	let el: HTMLElement | null = null, tab: string | undefined
	let bottom = false, manual = false, was = { gap: 0, top: 0, height: 0, client: 0 }, hidden = false
	let gap = (e: HTMLElement) => Math.max(0, Math.round(e.scrollHeight - e.scrollTop - e.clientHeight))
	let hand = () => { manual = true; bottom = false }
	addEventListener('wheel', hand, { passive: true, capture: true })
	addEventListener('touchstart', hand, { passive: true, capture: true })
	addEventListener('keydown', (e: KeyboardEvent) => {
		if (scrollKeys.has(e.key) && !(e.target as Element | null)?.closest?.('textarea, input')) hand()
	}, { capture: true })
	// A press on the transcript's scrollbar, right of its content box.
	addEventListener('pointerdown', (e: PointerEvent) => {
		if (el && e.target === el && e.offsetX >= el.clientWidth) hand()
	}, { passive: true, capture: true })
	document.addEventListener('visibilitychange', () => { if (document.hidden) hidden = true; check() })
	let check = () => {
		let now = document.querySelector<HTMLElement>('.Transcript')
		// A new transcript or another tab restores its own place: start over.
		if (now !== el || app.state.shown !== tab) { el = now; tab = app.state.shown; bottom = !!el && gap(el) <= 1; manual = false; if (el) el.addEventListener('scroll', check, { passive: true }) }
		if (!el) return
		let g = gap(el)
		// A glide under way is still heading for the bottom.
		if (scroll.state.frame) return
		if (g <= 1) { bottom = true; manual = false; hidden = false }
		else if (bottom && !manual) {
			bottom = false
			let moved = Math.round(el.scrollTop - was.top), grew = el.scrollHeight - was.height, resized = el.clientHeight - was.client
			diagnostics.record('drift', document.visibilityState, g, was.gap)
			diagnostics.report()
			notices.add({ key: 'scroll-drift', kind: 'attention', title: `Scroll left the bottom by itself: ${g}px`, line: `Gap was ${was.gap}px. Moved ${moved}px, content ${grew >= 0 ? '+' : ''}${grew}px, view ${resized >= 0 ? '+' : ''}${resized}px${hidden ? ', after the tab was hidden' : ''}.` })
		}
		was = { gap: g, top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }
	}
	setInterval(check, 250)
}

export const drift = { init }
