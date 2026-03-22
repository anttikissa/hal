#!/usr/bin/env bun

// Standalone terminal redraw debugger.
// No imports. No shared renderer. No tests.
//
// Behavior:
// - starts with 20 lines of output
// - keeps a "> ..." prompt at the bottom
// - prompt editing supports typing, backspace, left, right
// - Enter submits the prompt
//   - if prompt is a positive integer N, append N lines
//   - otherwise append one echo line
// - Ctrl-L forces a redraw
// - Ctrl-C / Ctrl-D exits without clearing

const blocks: string[] = Array.from({ length: 20 }, (_, i) => stampLine(`${i + 1}`))
let nextBlock = blocks.length + 1
let promptText = ''
let promptCursor = 0
let previousFrameRows = 0
let appendedRows = 0
let previousLines: string[] = []

function visibleWidth(text: string): number {
	// This harness only deals with plain text. That keeps width math obvious.
	return text.length
}

function twoDigits(value: number): string {
	return String(value).padStart(2, '0')
}

function threeDigits(value: number): string {
	return String(value).padStart(3, '0')
}

function timestamp(): string {
	const now = new Date()
	return `${twoDigits(now.getHours())}:${twoDigits(now.getMinutes())}:${twoDigits(now.getSeconds())}.${threeDigits(now.getMilliseconds())}`
}

function stampLine(text: string): string {
	return `${timestamp()} ${text}`
}

function countRenderedRows(lines: string[], cols: number): number {
	let rows = 0
	for (let i = 0; i < lines.length; i++) {
		const width = visibleWidth(lines[i]!)
		const lineRows = Math.max(1, Math.ceil(width / cols))
		rows += lineRows
		if (i < lines.length - 1 && width > 0 && width % cols === 0) rows += 1
	}
	return rows
}

function renderPrompt(): string {
	return `> ${promptText}`
}

function buildFrameLines(): string[] {
	return [...blocks, renderPrompt()]
}

function moveUp(rows: number): string {
	return rows > 0 ? `\x1b[${rows}A` : ''
}

function cursorToPromptColumn(): string {
	return `\r\x1b[${promptCursor + 3}G`
}

function writeFrame(lines: string[]): void {
	process.stdout.write(lines.join('\r\n'))
}

function draw(force = false): void {
	const cols = process.stdout.columns || 80
	const rows = process.stdout.rows || 24
	const lines = buildFrameLines()
	const frameRows = countRenderedRows(lines, cols)
	const maxOrganicRows = Math.max(0, rows - 1)
	const shouldGrow = !force && appendedRows < maxOrganicRows && frameRows > previousFrameRows

	if (previousFrameRows === 0) {
		writeFrame(lines)
		previousFrameRows = frameRows
		appendedRows = previousFrameRows
		previousLines = lines
		process.stdout.write(cursorToPromptColumn())
		return
	}

	if (shouldGrow) {
		const commonPrefix = sharedPrefixCount(previousLines, lines)
		const suffix = lines.slice(commonPrefix)
		const canContinueFromPrompt = commonPrefix >= previousLines.length - 1
		if (suffix.length > 0 && canContinueFromPrompt) {
			if (commonPrefix === previousLines.length) process.stdout.write('\r\n')
			else process.stdout.write('\r')
			writeFrame(suffix)
			previousFrameRows = frameRows
			appendedRows = Math.min(previousFrameRows, rows)
			previousLines = lines
			process.stdout.write(cursorToPromptColumn())
			return
		}
	}

	process.stdout.write(`\r${moveUp(Math.min(previousFrameRows - 1, rows - 1))}\x1b[J`)
	writeFrame(lines)
	previousFrameRows = frameRows
	appendedRows = Math.min(previousFrameRows, rows)
	previousLines = lines
	process.stdout.write(cursorToPromptColumn())
}

function sharedPrefixCount(a: string[], b: string[]): number {
	let i = 0
	while (i < a.length && i < b.length && a[i] === b[i]) i += 1
	return i
}

function redraw(force = false): void {
	draw(force)
}

function exit(code: number): void {
	if (process.stdin.isTTY) process.stdin.setRawMode(false)
	process.stdout.write('\r\n')
	process.exit(code)
}

if (process.stdin.isTTY) {
	process.stdin.setRawMode(true)
	process.stdin.resume()
}

redraw()

process.stdin.on('data', (data: Buffer) => {
	for (let i = 0; i < data.length; i++) {
		const byte = data[i]!

		if (byte === 0x03 || byte === 0x04) {
			exit(0)
		}

		if (byte === 0x0c) {
			redraw(true)
			continue
		}

		if (byte === 0x1b && data[i + 1] === 0x5b && data[i + 2] === 0x44) {
			promptCursor = Math.max(0, promptCursor - 1)
			i += 2
			redraw()
			continue
		}

		if (byte === 0x1b && data[i + 1] === 0x5b && data[i + 2] === 0x43) {
			promptCursor = Math.min(promptText.length, promptCursor + 1)
			i += 2
			redraw()
			continue
		}

		if ((byte === 0x7f || byte === 0x08) && promptCursor > 0) {
			promptText = promptText.slice(0, promptCursor - 1) + promptText.slice(promptCursor)
			promptCursor -= 1
			redraw()
			continue
		}

		if (byte === 0x0d || byte === 0x0a) {
			const count = Number.parseInt(promptText, 10)
			if (promptText !== '' && String(count) === promptText && count > 0) {
				for (let line = 0; line < count; line++) blocks.push(stampLine(`Inserted ${nextBlock++}`))
			} else {
				blocks.push(stampLine(`You said: ${JSON.stringify(promptText)}`))
				nextBlock = blocks.length + 1
			}
			promptText = ''
			promptCursor = 0
			redraw()
			continue
		}
		if (byte >= 0x20 && byte <= 0x7e) {
			const char = String.fromCharCode(byte)
			promptText = promptText.slice(0, promptCursor) + char + promptText.slice(promptCursor)
			promptCursor += 1
			redraw()
		}
	}
})
