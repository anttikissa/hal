// The terminal's local copy of each session's draft and unacknowledged
// prompts (common/drafts.ts): one ASON file per session in dir(), so
// typed text outlives a lost host and a crash of this process. Written
// atomically (temp file + rename) on every change; a session with
// nothing to keep has no file.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { ason } from '../common/ason.ts'
import type { Local } from '../common/drafts.ts'

function path(id: string): string {
	if (!/^[\w-]+$/.test(id)) throw new Error(`invalid session id: ${JSON.stringify(id)}`)
	return `${draftFile.dir()}/${id}.ason`
}

// The stored copy; undefined if there is none or it is unreadable.
function load(id: string): Local | undefined {
	try {
		return ason.parse(readFileSync(draftFile.path(id), 'utf8')) as unknown as Local
	} catch {
		return undefined
	}
}

// Terminals of other Hal processes following the same session write
// the same file (with the same content, from the host's draft), hence a
// temp file per process. A failed write never takes the terminal down:
// the host keeps the draft too.
function save(id: string, local: Local): void {
	let file = draftFile.path(id)
	let tmp = `${file}.${process.pid}.tmp`
	try {
		if (!local.text && !local.sending.length && !local.queueEdit) return rmSync(file, { force: true })
		mkdirSync(draftFile.dir(), { recursive: true, mode: 0o700 })
		writeFileSync(tmp, ason.stringify(local) + '\n', { mode: 0o600 })
		renameSync(tmp, file)
	} catch {
		rmSync(tmp, { force: true })
	}
}

export const draftFile = {
	// Set by main.ts: state/drafts in the home.
	dir: (): string => {
		throw new Error('draftFile.dir is not set')
	},
	path,
	load,
	save,
}
