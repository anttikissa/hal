#!/usr/bin/env bun

// term.ts — Terminal UI skeleton for Hal.
// Layout: [history lines...] [status bar] [prompt]
//
// Rendering: differential. We track all previously-painted lines and only
// repaint from the first changed line. New lines are appended with \r\n,
// which lets the terminal scroll naturally — old content enters scrollback.

const CSI = '\x1b['
const history: string[] = []
let promptText = ''
let prevLines: string[] = []
let cursorRow = 0 // which logical line the cursor is on

function paint(force = false): void {
	const lines = [
		...history,
		`── ${history.length} lines ──`,
		`> ${promptText}`,
	]

	if (force) {
		// Full repaint: clear screen, reset tracking, rewrite everything.
		process.stdout.write(`${CSI}2J${CSI}H`)
		prevLines = []
		cursorRow = 0
	}

	// Find the first line that differs from what's on screen.
	let first = -1
	const max = Math.max(lines.length, prevLines.length)
	for (let i = 0; i < max; i++) {
		if ((lines[i] ?? '') !== (prevLines[i] ?? '')) {
			first = i
			break
		}
	}
	if (first === -1) return // nothing changed

	const out: string[] = [`${CSI}?2026h`, `${CSI}?25l`]

	// Move cursor from its current row to the first changed line.
	const delta = first - cursorRow
	if (delta < 0) out.push(`${CSI}${-delta}A`)
	else if (delta > 0) out.push(`${CSI}${delta}B`)
	out.push('\r')

	// Rewrite from the first changed line to the end.
	for (let i = first; i < lines.length; i++) {
		if (i > first) out.push('\r\n')
		out.push(`${CSI}2K${lines[i]}`)
	}

	cursorRow = lines.length - 1

	// Position cursor after "> " plus typed text (CSI G is 1-indexed).
	out.push(`\r${CSI}${promptText.length + 3}G`)
	out.push(`${CSI}?25h`, `${CSI}?2026l`)

	prevLines = lines
	process.stdout.write(out.join(''))
}

function handleInput(data: Buffer): void {
	for (let i = 0; i < data.length; i++) {
		const b = data[i]!
		if (b === 0x03 || b === 0x04) {
			if (process.stdin.isTTY) process.stdin.setRawMode(false)
			process.stdout.write('\r\n')
			process.exit(0)
		}
		if (b === 0x0c) { paint(true); continue }
		if (b === 0x0d || b === 0x0a) {
			if (promptText) {
				history.push(`> ${promptText}`)
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
		if ((b === 0x7f || b === 0x08) && promptText.length) {
			promptText = promptText.slice(0, -1)
			paint(); continue
		}
		if (b >= 0x20 && b < 0x7f) {
			promptText += String.fromCharCode(b)
			paint(); continue
		}
	}
}

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.on('resize', () => paint(true))
paint()
process.stdin.on('data', handleInput)
