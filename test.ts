#!/usr/bin/env bun

// test.ts — Two modes of force repaint, demonstrated.
//
// Mode 1: content fits on screen.
//   Move up to top of our content, clear downward, rewrite in place.
//   Scrollback is NOT touched — pre-app shell history survives.
//
// Mode 2: content is taller than the terminal.
//   CSI nA can't reach scrollback. We MUST clear it (CSI 3J) first,
//   then rewrite everything from scratch.
//
// Usage: run in a ~26 row terminal.
//   Type a number, press Enter → set line count and force repaint.
//   Press Enter alone → force repaint with same line count.
//   Scroll up after each repaint to inspect scrollback.

const CSI = '\x1b['

let lineCount = 5
let generation = 0
let cursorRow = 0
let promptBuf = ''

// Once the frame has exceeded the terminal height, we can never go back to
// mode 1. Old content is stuck in scrollback and we'd show a mix of old and
// new. This flag is one-way: once true, stays true forever.
let mustClearScrollback = false

function paint(force: boolean): void {
	const rows = process.stdout.rows || 26

	// Build frame: content lines + status line + prompt line.
	const content: string[] = []
	for (let i = 1; i <= lineCount; i++) {
		content.push(`[gen ${generation}] line ${i} of ${lineCount}`)
	}

	const totalLines = content.length + 2
	if (totalLines > rows) mustClearScrollback = true
	const fitsOnScreen = !mustClearScrollback
	const mode = fitsOnScreen
		? 'MODE 1: fits on screen — scrollback preserved'
		: 'MODE 2: taller than terminal — scrollback cleared'

	const lines = [
		...content,
		`── ${mode} ── [${totalLines}/${rows} rows]`,
		`> ${promptBuf}`,
	]

	if (force) {
		const out: string[] = [`${CSI}?2026h`, `${CSI}?25l`]

		if (fitsOnScreen) {
			// MODE 1: move to top of our content, clear from there down.
			const up = Math.min(cursorRow, rows - 1)
			out.push('\r')
			if (up > 0) out.push(`${CSI}${up}A`)
			out.push(`${CSI}J`)
		} else {
			// MODE 2: clear screen + scrollback, cursor home.
			out.push(`${CSI}2J${CSI}H${CSI}3J`)
		}

		for (let i = 0; i < lines.length; i++) {
			if (i > 0) out.push('\r\n')
			out.push(lines[i])
		}
		cursorRow = lines.length - 1
		out.push(`\r${CSI}${promptBuf.length + 3}G`)
		out.push(`${CSI}?25h`, `${CSI}?2026l`)
		process.stdout.write(out.join(''))
		return
	}

	// First paint: just write.
	const out: string[] = [`${CSI}?2026h`, `${CSI}?25l`]
	for (let i = 0; i < lines.length; i++) {
		if (i > 0) out.push('\r\n')
		out.push(lines[i])
	}
	cursorRow = lines.length - 1
	out.push(`\r${CSI}${promptBuf.length + 3}G`)
	out.push(`${CSI}?25h`, `${CSI}?2026l`)
	process.stdout.write(out.join(''))
}

function handleInput(data: Buffer): void {
	for (let i = 0; i < data.length; i++) {
		const b = data[i]!

		if (b === 0x03) {
			if (process.stdin.isTTY) process.stdin.setRawMode(false)
			process.stdout.write('\r\n')
			process.exit(0)
		}

		if (b === 0x0d || b === 0x0a) {
			const n = parseInt(promptBuf, 10)
			if (n > 0) lineCount = n
			promptBuf = ''
			generation++
			paint(true)
			continue
		}

		if ((b === 0x7f || b === 0x08) && promptBuf.length) {
			promptBuf = promptBuf.slice(0, -1)
			paint(true)
			continue
		}

		if (b >= 0x20 && b < 0x7f) {
			promptBuf += String.fromCharCode(b)
			paint(true)
			continue
		}
	}
}

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
paint(false)
process.stdin.on('data', handleInput)
