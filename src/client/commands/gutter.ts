// /gutter (Ctrl-G): toggles the transcript's blank side columns, so
// text copied from it reaches both edges.

import { ansi } from '../ansi.ts'
import { frame } from '../frame.ts'
import { frameLayout } from '../frame-layout.ts'
import { render } from '../render.ts'

export const command = {
	run: (): void => {
		ansi.gutter = !ansi.gutter
		frame.state.rows = new WeakMap()
		frame.state.peaks.clear()
		frameLayout.state.history = undefined
		render.request('Ctrl-G or /gutter')
	},
}
