/// <reference lib="dom" />
// A temporary opt-in probe that records why the view scrolls away from
// where it should be (tasks s0, 981). Snapshots of structural
// transitions survive event traffic; unpinned gaps are evidence, not
// failures.
import { scrollCauses, type Breadcrumb } from '../common/web-diagnostics.ts'
import { notices } from '../common/notices.ts'
import { diagnostics } from './diagnostics.ts'
import { scroll } from './scroll.ts'

function init(): void {
	let trace = (
		why: string,
		kind: 'scroll' | 'pulled' | 'drift' | 'pin' = 'scroll',
		gap?: number,
		extra?: { from?: number; delta?: number; up?: boolean },
	) => {
		let st = scroll.state,
			el = st.el
		if (!el) return
		let e = diagnostics.record(kind, document.visibilityState, gap)
		if (e)
			Object.assign(e, {
				cause: scrollCauses.find((cause) => cause === why) ?? 'other',
				scroll: {
					top: Math.max(0, el.scrollTop),
					height: el.scrollHeight,
					client: el.clientHeight,
					gap: scroll.gap(el),
					pinned: st.pinned,
					held: !!st.held,
					intent: !!st.intent,
					...extra,
				},
			} satisfies Partial<Breadcrumb>)
		diagnostics.report()
	}
	scroll.onTrace = (why, gap, wheel) =>
		trace(
			why,
			gap === undefined ? 'scroll' : 'pulled',
			gap,
			wheel === undefined ? undefined : { delta: Math.abs(wheel), up: wheel < 0 },
		)
	// Debug marker: green while following the bottom, red for
	// 8 s after following ends, so the moment is noticed.
	let mark = document.body.appendChild(document.createElement('div')),
		fade: ReturnType<typeof setTimeout> | undefined
	mark.className = 'ScrollMark'
	let show = (why?: string) => {
		clearTimeout(fade)
		let on = scroll.state.pinned
		mark.className = `ScrollMark ${on ? 'heat-0' : why ? 'heat-100' : ''}`
		mark.textContent = on ? 'following bottom' : why ? `left bottom: ${why}` : 'not following'
		if (!on && why) fade = setTimeout(show, 8000)
	}
	show()
	scroll.onPin = (why, from) => {
		trace(why, 'pin', undefined, { from: Math.max(0, from) })
		show(why)
	}
	let stuck = 0,
		previous = ''
	setInterval(() => {
		let st = scroll.state,
			el = st.el
		let short: 'drift' | 'scroll' | '' = el && scroll.gap(el) > 1 ? (st.pinned ? 'drift' : 'scroll') : ''
		stuck = short === previous ? stuck + 1 : 1
		previous = short
		if (!short || stuck !== 2) return
		let gap = Math.round(scroll.gap(el!))
		trace('sample', short, gap)
		if (short !== 'drift') return
		notices.add({
			key: 'scroll-drift',
			kind: 'failed',
			title: `Scroll stuck above the bottom: ${gap}px`,
			line: 'Pinned, yet not pulled back. A bug in scroll.ts.',
		})
	}, 250)
}

export const drift = { init }
