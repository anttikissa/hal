// Diagnostics: host-side notes for humans debugging Hal. They go to
// state/diag.log, never to stdout (the terminal UI owns it) and never into
// session history, so the model never sees them. Every line is redacted.

import { appendFileSync } from 'fs'
import { redaction } from '../common/redact.ts'
import { paths } from './paths.ts'

function file(): string {
	return `${paths.stateDir()}/diag.log`
}

function log(message: string): void {
	let line = `${new Date().toISOString()} ${redaction.redact(message)}\n`
	appendFileSync(diag.file(), line, { mode: 0o600 })
}

export const diag = { file, log }
