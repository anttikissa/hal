// Shared fixtures for the EDIT tool tests: a run helper and test files.
import { writeFileSync } from 'fs'
import { tool as multiedit } from './edit.ts'
import { client, created, testHome } from '../host-fixture.test.ts'

export const nl = String.fromCharCode(10),
	crlf = String.fromCharCode(13, 10)
export const run = (edits: unknown[], signal = new AbortController().signal) =>
	multiedit.run({ edits }, { cwd: testHome(), sessionId: created(client(), testHome()), signal, callId: 'edit' })
export const file = (name: string, text: string) => {
	writeFileSync(`${testHome()}/${name}`, text)
	return `${testHome()}/${name}`
}
