/// <reference lib="dom" />
// Temporary opt-in scroll probe (tasks s0, 981). Structural transition
// snapshots survive event traffic; unpinned gaps are evidence, not failures.
import { scrollCauses, type Breadcrumb } from '../common/web-diagnostics.ts'
import { notices } from '../common/notices.ts'
import { diagnostics } from './diagnostics.ts'
import { scroll } from './scroll.ts'

function init(): void {
	let trace = (why: string, kind: 'scroll' | 'pulled' | 'drift' = 'scroll', gap?: number) => {
		let st = scroll.state, el = st.el
		if (!el) return
		let e = diagnostics.record(kind, document.visibilityState, gap)
		if (e) Object.assign(e, { cause: scrollCauses.find((cause) => cause === why) ?? 'other', scroll: { top: Math.max(0, el.scrollTop), height: el.scrollHeight, client: el.clientHeight, gap: scroll.gap(el), pinned: st.pinned, held: !!st.held, intent: !!st.intent } } satisfies Partial<Breadcrumb>)
		diagnostics.report()
	}
	scroll.onTrace = (why, gap) => trace(why, gap === undefined ? 'scroll' : 'pulled', gap)
	let stuck = 0, previous = ''
	setInterval(() => {
		let st = scroll.state, el = st.el
		let short: 'drift' | 'scroll' | '' = el && scroll.gap(el) > 1 ? st.pinned ? 'drift' : 'scroll' : ''
		stuck = short === previous ? stuck + 1 : 1
		previous = short
		if (!short || stuck !== 2) return
		let gap = Math.round(scroll.gap(el!))
		trace('sample', short, gap)
		if (short !== 'drift') return
		notices.add({ key: 'scroll-drift', kind: 'failed', title: `Scroll stuck above the bottom: ${gap}px`, line: 'Pinned, yet not pulled back. A bug in scroll.ts.' })
	}, 250)
}

export const drift = { init }
