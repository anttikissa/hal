import { appendFileSync, mkdirSync } from 'fs'
import { STATE_DIR } from '../state.ts'
import { ason } from '../utils/ason.ts'

type WriteOptions = {
	bypassExternalEditorLatch?: boolean
}

const config = {
	// Record renderer writes as readable ASON lines in state/terminal-output.asonl.
	// This is intentionally off except while diagnosing terminal behavior.
	capture: false,
}

const state = {
	externalEditorOpen: false,
	capturePath: `${STATE_DIR}/terminal-output.asonl`,
}

function setExternalEditorOpen(value: boolean): void {
	state.externalEditorOpen = value
}

function isExternalEditorOpen(): boolean {
	return state.externalEditorOpen
}

function escapeControlBytes(text: string): string {
	return text.replace(/[\x00-\x1f\x7f]/g, (ch) => {
		if (ch === '\x1b') return '\\x1b'
		if (ch === '\r') return '\\r'
		if (ch === '\n') return '\\n'
		if (ch === '\t') return '\\t'
		return `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`
	})
}

function capture(text: string): void {
	if (!config.capture) return
	const record = {
		ts: new Date().toISOString(),
		pid: process.pid,
		bytes: Buffer.byteLength(text),
		text: escapeControlBytes(text),
	}
	try {
		mkdirSync(STATE_DIR, { recursive: true })
		appendFileSync(state.capturePath, `${ason.stringify(record, 'short')}\n`)
	} catch {
		// Diagnostics must never interfere with the terminal's actual output.
	}
}

function write(text: string, opts: WriteOptions = {}): boolean {
	if (state.externalEditorOpen && !opts.bypassExternalEditorLatch) return false
	capture(text)
	return process.stdout.write(text)
}

async function flush(): Promise<void> {
	await new Promise<void>((resolve) => {
		process.stdout.write('', () => resolve())
	})
}

export const terminalOutput = { config, state, setExternalEditorOpen, isExternalEditorOpen, escapeControlBytes, capture, write, flush }
