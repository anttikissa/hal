#!/usr/bin/env bun

// term.ts — Terminal UI skeleton for Hal.
//
// Layout (three sections, top to bottom):
//   [history lines...]   — append-only log of user input echoes, responses, etc.
//   [status bar]         — single line, shows line count
//   [prompt]             — single line, "> " + user input
//
// Rendering strategy: DIFFERENTIAL.
//
// We keep the full logical frame (all history + status + prompt) and diff it
// against the previously-painted frame. Only the lines from the first
// difference onward get rewritten. New lines are appended via \r\n, which
// makes the terminal scroll naturally — old content enters scrollback and
// the user can scroll up to see everything.
//
// Two render paths:
//   Normal (force=false): diff prevLines vs new lines, rewrite from first diff.
//   Force  (force=true):  move to top of visible area, clear downward, repaint
//                          visible portion. Used by Ctrl-L and resize. Does NOT
//                          touch scrollback — no duplication.
//
// See docs/terminal.md for the full contract.

const CSI = '\x1b['

// ── State ────────────────────────────────────────────────────────────────────

// Append-only history. Each entry is one line of text.
const history: string[] = []

// Current prompt input buffer.
let promptText = ''

// The exact lines we wrote to the terminal last paint. Used for diffing.
// This is the FULL logical array, not a viewport slice.
let prevLines: string[] = []

// Which logical line index the terminal cursor is sitting on.
// After a paint, this is always the last line (the prompt).
let cursorRow = 0

// ── Rendering ────────────────────────────────────────────────────────────────

function paint(force = false): void {
	// Build the full frame: every history line, then status, then prompt.
	const lines = [
		...history,
		`── ${history.length} lines ──`,
		`> ${promptText}`,
	]

	if (force) {
		// FORCE REPAINT (Ctrl-L, resize)
		//
		// We can't just "clear screen + rewrite everything" because CSI 2J only
		// clears the visible screen, not scrollback. If the frame is taller than
		// the terminal, the old scrollback would remain and we'd duplicate content.
		//
		// Instead: move the cursor to the top of the visible area (up by at most
		// rows-1), clear from there to the bottom (CSI J), and write just the
		// lines that fit on screen. Scrollback stays untouched.
		const rows = process.stdout.rows || 24
		const up = Math.min(cursorRow, rows - 1)
		const start = Math.max(0, lines.length - rows)
		const out: string[] = [
			`${CSI}?2026h`,                                    // begin synchronized output
			`${CSI}?25l`,                                      // hide cursor during paint
			'\r',                                              // column 0
			up > 0 ? `${CSI}${up}A` : '',                     // move to top of visible area
			`${CSI}J`,                                         // clear from cursor to end of screen
		]
		for (let i = start; i < lines.length; i++) {
			if (i > start) out.push('\r\n')
			out.push(`${CSI}2K${lines[i]}`)                   // clear line + write content
		}
		cursorRow = lines.length - 1
		prevLines = lines
		out.push(`\r${CSI}${promptText.length + 3}G`)         // place cursor in prompt
		out.push(`${CSI}?25h`, `${CSI}?2026l`)                // show cursor, end sync
		process.stdout.write(out.join(''))
		return
	}

	// NORMAL REPAINT: diff against previous frame.
	//
	// Walk both arrays to find the first line that differs. Everything before
	// that is already correct on screen and doesn't need touching.
	let first = -1
	const max = Math.max(lines.length, prevLines.length)
	for (let i = 0; i < max; i++) {
		if ((lines[i] ?? '') !== (prevLines[i] ?? '')) {
			first = i
			break
		}
	}
	if (first === -1) return // nothing changed — skip the write entirely

	const out: string[] = [
		`${CSI}?2026h`,                                        // begin synchronized output
		`${CSI}?25l`,                                          // hide cursor during paint
	]

	// Move cursor from its current row to the first changed line.
	// Negative delta = move up, positive = move down.
	const delta = first - cursorRow
	if (delta < 0) out.push(`${CSI}${-delta}A`)
	else if (delta > 0) out.push(`${CSI}${delta}B`)
	out.push('\r')                                             // column 0

	// Rewrite every line from the first change to the end. Each line is
	// preceded by CSI 2K (clear entire line) to wipe any leftover content
	// from the previous frame. Lines after the first get a \r\n to advance.
	for (let i = first; i < lines.length; i++) {
		if (i > first) out.push('\r\n')
		out.push(`${CSI}2K${lines[i]}`)
	}

	// Cursor is now on the last line (the prompt).
	cursorRow = lines.length - 1

	// Place the cursor at the right column in the prompt.
	// "> " is 2 chars, so typed text starts at column 2 (0-indexed).
	// CSI G is 1-indexed, so column = promptText.length + 2 + 1 = +3.
	out.push(`\r${CSI}${promptText.length + 3}G`)
	out.push(`${CSI}?25h`, `${CSI}?2026l`)                    // show cursor, end sync

	prevLines = lines
	process.stdout.write(out.join(''))
}

// ── Input handling ───────────────────────────────────────────────────────────

function handleInput(data: Buffer): void {
	for (let i = 0; i < data.length; i++) {
		const b = data[i]!

		// Ctrl-C / Ctrl-D: exit cleanly, leave last frame visible.
		if (b === 0x03 || b === 0x04) {
			if (process.stdin.isTTY) process.stdin.setRawMode(false)
			process.stdout.write('\r\n')
			process.exit(0)
		}

		// Ctrl-L: force full repaint of visible area.
		if (b === 0x0c) { paint(true); continue }

		// Enter: submit prompt.
		if (b === 0x0d || b === 0x0a) {
			if (promptText) {
				// Echo the user's input into history.
				history.push(`> ${promptText}`)

				// If the input is a positive integer, generate that many test lines.
				// Otherwise echo it back.
				const n = parseInt(promptText, 10)
				if (n > 0 && String(n) === promptText) {
					for (let j = 0; j < n; j++) history.push(`line ${history.length}`)
				} else {
					history.push(`You wrote: ${promptText}`)
				}
				promptText = ''
			}
			paint(); continue
		}

		// Backspace: delete last character.
		if ((b === 0x7f || b === 0x08) && promptText.length) {
			promptText = promptText.slice(0, -1)
			paint(); continue
		}

		// Printable ASCII: append to prompt.
		if (b >= 0x20 && b < 0x7f) {
			promptText += String.fromCharCode(b)
			paint(); continue
		}
	}
}

// ── Startup ──────────────────────────────────────────────────────────────────

// Enter raw mode so we get individual keypresses instead of line-buffered input.
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()

// Repaint on terminal resize (dimensions changed, need to recalculate visible area).
process.stdout.on('resize', () => paint(true))

// Initial paint — appends at current cursor position, like a REPL.
paint()

// Start processing input.
process.stdin.on('data', handleInput)
