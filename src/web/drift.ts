/// <reference lib="dom" />
// Temporary probe (task s0) for the transcript leaving the bottom
// without the reader scrolling. On while webDiagnostics is on. Task
// 5cz deletes it after 7 days with no 'drift' entry: this file, its
// line in main.tsx, the 'drift' and 'pulled' kinds, scroll.onPull.
//
// scroll.ts keeps a pinned reader at the bottom. This reports both:
// - 'pulled': scroll.ts found a pinned view above the bottom and
//   pulled it back, so something other than the reader moved it.
// - 'drift': pinning failed: still pinned, above the bottom
//   for two checks in a row (a bug in scroll.ts).
// Each logs a breadcrumb (detail: page visibility; line: gap px).
// Only failed pinning shows a notice.
import { notices } from '../common/notices.ts'
import { diagnostics } from './diagnostics.ts'
import { scroll } from './scroll.ts'

function init(): void {
	scroll.onPull = (gap) => {
		diagnostics.record('pulled', document.visibilityState, gap)
		diagnostics.report()
	}
	let stuck = 0
	setInterval(() => {
		let st = scroll.state, el = st.el
		let short = !!el && st.pinned && !st.pressing && !st.touching && scroll.gap(el) > 1
		stuck = short ? stuck + 1 : 0
		if (stuck !== 2) return
		let gap = Math.round(scroll.gap(el!))
		diagnostics.record('drift', document.visibilityState, gap)
		diagnostics.report()
		notices.add({ key: 'scroll-drift', kind: 'failed', title: `Scroll stuck above the bottom: ${gap}px`, line: 'Pinned, yet not pulled back. A bug in scroll.ts.' })
	}, 250)
}

export const drift = { init }
