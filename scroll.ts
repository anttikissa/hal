#!/usr/bin/env bun

// scroll.ts — Test: can we overwrite lines that have scrolled into scrollback?
//
// Assumes a 26-line terminal. Writes 50 lines (lines 1–50), so lines 1–24
// scroll into scrollback and lines 25–50 are visible.
//
// Press Enter to attempt to overwrite ALL 50 lines by moving up 49 rows
// and rewriting. If scrollback lines can be overwritten, you'll see
// "REWRITTEN 1" through "REWRITTEN 50". If not, you'll see the original
// lines 1–24 in scrollback and only the visible ones rewritten.

const CSI = '\x1b['

// Write 50 lines.
const lines: string[] = []
for (let i = 1; i <= 50; i++) lines.push(`original line ${i}`)
process.stdout.write(lines.join('\r\n'))

// Cursor is now on line 50 (the last one).

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()

process.stdin.on('data', (data: Buffer) => {
	const b = data[0]!

	// Ctrl-C: quit
	if (b === 0x03) {
		if (process.stdin.isTTY) process.stdin.setRawMode(false)
		process.stdout.write('\r\n')
		process.exit(0)
	}

	// Enter: try to move up 49 lines and rewrite all 50.
	if (b === 0x0d || b === 0x0a) {
		const out: string[] = []
		// Move up 49 lines from line 50.
		out.push(`${CSI}49A`)
		out.push('\r')
		// Rewrite all 50 lines.
		for (let i = 1; i <= 50; i++) {
			if (i > 1) out.push('\r\n')
			out.push(`${CSI}2K*** REWRITTEN ${i} ***`)
		}
		process.stdout.write(out.join(''))
	}
})
