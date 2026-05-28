#!/usr/bin/env bun

import { keys } from '../src/cli/keys.ts'

const CSI = '\x1b['
const KITTY_TERMS = /^(kitty|ghostty|iTerm\.app)$/
const KITTY_ON = '\x1b[>17u'
const KITTY_OFF = '\x1b[<u'
const BRACKETED_PASTE_ON = '\x1b[?2004h'
const BRACKETED_PASTE_OFF = '\x1b[?2004l'
const RUNTIME_MS = 10_000
const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.'

let cleaned = false
let started = Date.now()
let keypressCount = 0

function useKitty(): boolean {
	return KITTY_TERMS.test(process.env.TERM_PROGRAM ?? '')
}

function writeTabStops(cols: number, step: number): void {
	let seq = '\x1b[3g'
	for (let c = step + 1; c <= cols; c += step) seq += `${CSI}${c}G\x1bH`
	seq += `${CSI}1G`
	process.stdout.write(seq)
}

function setupTerminal(): void {
	if (!process.stdin.isTTY) {
		process.stdout.write('stdin is not a TTY; run this directly in the terminal you want to test.\r\n')
	}
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true)
		process.stdin.setEncoding('utf8')
		process.stdin.resume()
	}
	if (useKitty()) process.stdout.write(KITTY_ON)
	process.stdout.write(BRACKETED_PASTE_ON)
	writeTabStops(process.stdout.columns || 80, 4)
}

function cleanupTerminal(): void {
	if (cleaned) return
	cleaned = true
	if (useKitty()) process.stdout.write(KITTY_OFF)
	process.stdout.write(BRACKETED_PASTE_OFF)
	writeTabStops(process.stdout.columns || 80, 8)
	if (process.stdin.isTTY) process.stdin.setRawMode(false)
}

function visible(text: string): string {
	let out = ''
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0
		if (ch === '\x1b') out += '\\x1b'
		else if (ch === '\r') out += '\\r'
		else if (ch === '\n') out += '\\n'
		else if (ch === '\t') out += '\\t'
		else if (cp === 0x7f) out += '\\x7f'
		else if (cp < 0x20) out += `\\x${cp.toString(16).padStart(2, '0')}`
		else out += ch
	}
	return out
}

function hexBytes(text: string): string {
	const bytes = Buffer.from(text, 'utf8')
	let out: string[] = []
	for (const byte of bytes) out.push(byte.toString(16).padStart(2, '0'))
	return out.join(' ')
}

function formatKey(event: ReturnType<typeof keys.parseKeys>[number]): string {
	let parts: string[] = []
	if (event.cmd) parts.push('cmd')
	if (event.ctrl) parts.push('ctrl')
	if (event.alt) parts.push('alt')
	if (event.shift) parts.push('shift')
	parts.push(event.key)
	let rendered = parts.join('+')
	if (event.char !== undefined) rendered += ` char="${visible(event.char)}"`
	return rendered
}

function logKeypress(text: string): void {
setTimeout(() => {

	keypressCount++
	const elapsed = String(Date.now() - started).padStart(5, ' ')
	const parsed = keys.parseKeys(text)
	process.stdout.write(`\r\nkeypress ${String(keypressCount).padStart(3, '0')} +${elapsed}ms raw="${visible(text)}" hex=${hexBytes(text)}\r\n`)
	if (parsed.length === 0) {
		process.stdout.write('  parsed: (none)\r\n')
		return
	}
	for (const event of parsed) process.stdout.write(`  parsed: ${formatKey(event)}\r\n`)
}, 3000)

}

function printLorem(): void {
	process.stdout.write('\r\nHal terminal-mode repro: raw mode, UTF-8 stdin, Kitty keyboard protocol when TERM_PROGRAM matches Hal, bracketed paste, tab stops=4.\r\n')
	process.stdout.write('Scroll up, select text, then hit Cmd-C. I will print any key bytes I receive. Quits after 10 seconds.\r\n\r\n')
	for (let i = 1; i <= 200; i++) {
		process.stdout.write(`${String(i).padStart(3, '0')} ${LOREM}\r\n`)
	}
	process.stdout.write('\r\n--- listening for keypresses for 10 seconds ---\r\n')
}

function finish(reason: string): void {
	cleanupTerminal()
	process.stdout.write(`\r\n--- ${reason}; exiting ---\r\n`)
	process.exit(0)
}

setupTerminal()
printLorem()

process.stdin.on('data', (data: Buffer | string) => {
	const text = typeof data === 'string' ? data : data.toString('utf8')
	logKeypress(text)
})

process.stdout.on('resize', () => writeTabStops(process.stdout.columns || 80, 4))
process.on('SIGWINCH', () => writeTabStops(process.stdout.columns || 80, 4))
process.on('SIGTERM', () => finish('SIGTERM'))
process.on('exit', cleanupTerminal)

setTimeout(() => finish('10 seconds elapsed'), RUNTIME_MS)
