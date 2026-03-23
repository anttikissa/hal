// Terminal renderer -- differential repaint engine.
// See docs/terminal.md for the full contract.
//
// The frame is an array of strings where each entry is ONE physical terminal
// row (already wrapped to terminal width). The diff engine compares against
// the previous frame and rewrites only what changed.
//
// NEVER put lines wider than terminal width into the frame. The diff engine
// assumes 1 array entry = 1 physical row. Wider lines auto-wrap and break
// cursor positioning.
//
// Two force-repaint modes (controlled by the `fullscreen` flag):
//   grow mode: frame fits on screen, rewrite in place, scrollback untouched.
//   full mode: frame exceeded terminal at some point, must CSI 3J scrollback.

const CSI = '\x1b['

let prevLines: string[] = []
let cursorRow = 0

// One-way flag. Once the frame exceeds terminal height, every force repaint
// must clear scrollback. See docs/terminal.md.
let fullscreen = false

export function isFullscreen(): boolean {
	return fullscreen
}

export function setFullscreen(v: boolean): void {
	fullscreen = v
}

// Reset renderer state (for tests).
export function resetRenderer(): void {
	prevLines = []
	cursorRow = 0
	fullscreen = false
}

export interface PaintOptions {
	force?: boolean
	// Visible width of the cursor position in the last line (for CSI G).
	cursorCol?: number
}

export function paint(lines: string[], options: PaintOptions = {}): void {
	const rows = process.stdout.rows || 24
	const force = options.force ?? false
	const cursorCol = options.cursorCol ?? 0

	// Check if frame exceeds terminal. Once true, never goes back.
	if (lines.length > rows) fullscreen = true

	if (force) {
		const out: string[] = [`${CSI}?2026h`, `${CSI}?25l`]

		if (!fullscreen) {
			// GROW MODE: frame fits on screen. Rewrite in place.
			// Scrollback untouched -- pre-app shell history survives.
			const up = Math.min(cursorRow, rows - 1)
			out.push('\r')
			if (up > 0) out.push(`${CSI}${up}A`)
			out.push(`${CSI}J`)
		} else {
			// FULL MODE: must clear scrollback.
			out.push(`${CSI}2J${CSI}H${CSI}3J`)
		}

		for (let i = 0; i < lines.length; i++) {
			if (i > 0) out.push('\r\n')
			out.push(lines[i]!)
		}
		cursorRow = lines.length - 1
		prevLines = lines
		out.push(`\r${CSI}${cursorCol + 1}G`)
		out.push(`${CSI}?25h`, `${CSI}?2026l`)
		process.stdout.write(out.join(''))
		return
	}

	// NORMAL REPAINT: diff against previous frame.
	let first = -1
	const max = Math.max(lines.length, prevLines.length)
	for (let i = 0; i < max; i++) {
		if ((lines[i] ?? '') !== (prevLines[i] ?? '')) {
			first = i
			break
		}
	}
	if (first === -1) return

	const out: string[] = [`${CSI}?2026h`, `${CSI}?25l`]
	const delta = first - cursorRow
	if (delta < 0) out.push(`${CSI}${-delta}A`)
	else if (delta > 0) out.push(`${CSI}${delta}B`)
	out.push('\r')

	for (let i = first; i < lines.length; i++) {
		if (i > first) out.push('\r\n')
		out.push(`${CSI}2K${lines[i]!}`)
	}

	cursorRow = lines.length - 1
	out.push(`\r${CSI}${cursorCol + 1}G`)
	out.push(`${CSI}?25h`, `${CSI}?2026l`)
	prevLines = lines
	process.stdout.write(out.join(''))
}
