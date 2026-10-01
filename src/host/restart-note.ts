// Who restarted Hal (task 2e): the restarting process writes a line to
// state/restart.ason just before it exits; the next host takes it and
// tells clients. Crashes and quits write nothing, so announce nothing.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { ason } from '../common/ason.ts'
import { paths } from './paths.ts'

const freshMs = 60_000

const state = { written: false, text: undefined as string | undefined, until: 0 }

function file(): string {
	return `${paths.stateDir()}/restart.ason`
}

// The first writer wins: /restart host on a terminal host also exits
// through Ctrl-R's path.
function write(text: string): void {
	if (state.written) return
	state.written = true
	try {
		writeFileSync(file(), ason.stringify({ text, at: Date.now() }) + '\n')
	} catch {}
}

// On becoming host: the fresh note, kept a minute for clients that join.
function take(): string | undefined {
	if (!existsSync(file())) return undefined
	try {
		let note = ason.parse(readFileSync(file(), 'utf8')) as { text?: unknown; at?: unknown }
		unlinkSync(file())
		if (typeof note.text !== 'string' || typeof note.at !== 'number' || Date.now() - note.at > freshMs) return undefined
		state.text = `Hal restarted by ${note.text}`
		state.until = Date.now() + freshMs
		return state.text
	} catch {
		return undefined
	}
}

// The notice for a client connecting now, if a restart was just taken.
function pending(): string | undefined {
	return state.text && Date.now() < state.until ? state.text : undefined
}

export const restartNote = { state, file, write, take, pending }
