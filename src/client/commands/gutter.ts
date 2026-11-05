// /gutter (Ctrl-G): toggles the blank column at each side, so text
// copied from the terminal starts at the edge.

import { ansi } from '../ansi.ts'
import { frame } from '../frame.ts'
import { frameLayout } from '../frame-layout.ts'
import { render } from '../render.ts'

export const command = {
	run: (): void => {
		ansi.PAD = ansi.PAD ? '' : ' '
		frame.state.rows = new WeakMap()
		frame.state.peaks.clear()
		frameLayout.state.history = undefined
		render.request('Ctrl-G or /gutter')
	},
}
