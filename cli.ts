#!/usr/bin/env bun

// Standalone terminal redraw debugger.
// No imports. No shared code. Single file.
//
// - starts with 20 timestamped lines
// - prompt at bottom: "> ..."
// - typing, backspace, left/right work
// - Enter: numeric N appends N lines, otherwise echoes input
// - Ctrl-L force redraw
// - Ctrl-C / Ctrl-D exits without clearing

const lines: string[] = []
let promptText = ''
let promptCursor = 0
let cursorRow = 0  // which frame line the terminal cursor is on (0-based)
let nextId = 1

function ts(): string {
	const d = new Date()
	const hh = String(d.getHours()).padStart(2, '0')
	const mm = String(d.getMinutes()).padStart(2, '0')
	const ss = String(d.getSeconds()).padStart(2, '0')
	const ms = String(d.getMilliseconds()).padStart(3, '0')
	return `${hh}:${mm}:${ss}.${ms}`
}

function addLine(text: string): void {
	lines.push(`${ts()} ${text}`)
}

// seed 20 lines
for (let i = 0; i < 20; i++) addLine(`line ${nextId++}`)

function draw(): void {
	const frame = [...lines, `> ${promptText}`]
	const out: string[] = []

	// hide cursor during repaint
	out.push('\x1b[?25l')

	// move up to frame top (from wherever cursor currently is)
	if (cursorRow > 0) out.push(`\x1b[${cursorRow}A`)

	// clear from frame top to end of screen
	out.push('\r\x1b[J')

	// write every line
	for (let i = 0; i < frame.length; i++) {
		if (i > 0) out.push('\r\n')
		out.push(frame[i]!)
	}

	// cursor is now on the last line (prompt)
	cursorRow = frame.length - 1

	// position cursor within prompt
	out.push(`\r\x1b[${promptCursor + 3}G`)

	// show cursor
	out.push('\x1b[?25h')

	process.stdout.write(out.join(''))
}

// initial draw
draw()

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()

process.stdin.on('data', (data: Buffer) => {
	for (let i = 0; i < data.length; i++) {
		const byte = data[i]!

		// Ctrl-C / Ctrl-D: exit
		if (byte === 0x03 || byte === 0x04) {
			if (process.stdin.isTTY) process.stdin.setRawMode(false)
			process.stdout.write('\r\n')
			process.exit(0)
		}

		// Ctrl-L: force redraw
		if (byte === 0x0c) { draw(); continue }

		// left arrow
		if (byte === 0x1b && data[i + 1] === 0x5b && data[i + 2] === 0x44) {
			promptCursor = Math.max(0, promptCursor - 1)
			i += 2; draw(); continue
		}

		// right arrow
		if (byte === 0x1b && data[i + 1] === 0x5b && data[i + 2] === 0x43) {
			promptCursor = Math.min(promptText.length, promptCursor + 1)
			i += 2; draw(); continue
		}

		// backspace
		if ((byte === 0x7f || byte === 0x08) && promptCursor > 0) {
			promptText = promptText.slice(0, promptCursor - 1) + promptText.slice(promptCursor)
			promptCursor--
			draw(); continue
		}

		// enter
		if (byte === 0x0d || byte === 0x0a) {
			const n = parseInt(promptText, 10)
			if (promptText !== '' && String(n) === promptText && n > 0) {
				for (let j = 0; j < n; j++) addLine(`inserted ${nextId++}`)
			} else {
				addLine(`You said: ${JSON.stringify(promptText)}`)
			}
			promptText = ''
			promptCursor = 0
			draw(); continue
		}

		// printable ASCII
		if (byte >= 0x20 && byte <= 0x7e) {
			promptText = promptText.slice(0, promptCursor) + String.fromCharCode(byte) + promptText.slice(promptCursor)
			promptCursor++
			draw()
		}
	}
})
