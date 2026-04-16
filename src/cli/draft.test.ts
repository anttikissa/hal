import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { draft } from './draft.ts'
import { sessions } from '../server/sessions.ts'
import { ipc } from '../ipc.ts'

const origSessionDir = sessions.sessionDir
const origAppendEvent = ipc.appendEvent
const origConsoleError = console.error

let dir: string

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'hal-draft-test-'))
})

afterEach(() => {
	sessions.sessionDir = origSessionDir
	ipc.appendEvent = origAppendEvent
	console.error = origConsoleError
	rmSync(dir, { recursive: true, force: true })
})

test('saveDraft logs write failures and skips the draft_saved event', () => {
	const errors: string[] = []
	const events: any[] = []
	console.error = (...args: any[]) => {
		errors.push(args.join(' '))
	}
	ipc.appendEvent = (event: any) => {
		events.push(event)
	}
	// Point at a missing session directory so writeFileSync fails with ENOENT.
	sessions.sessionDir = () => join(dir, 'missing-session-dir')

	draft.saveDraft('04-test', 'hello')

	expect(events).toHaveLength(0)
	expect(errors).toHaveLength(1)
	expect(errors[0]).toContain('[draft] save 04-test:')
})

test('loadDraft logs parse failures and falls back to an empty draft', () => {
	const sessionDir = join(dir, '04-test')
	mkdirSync(sessionDir, { recursive: true })
	writeFileSync(join(sessionDir, 'draft.ason'), '{ definitely not valid ason')
	const errors: string[] = []
	console.error = (...args: any[]) => {
		errors.push(args.join(' '))
	}
	sessions.sessionDir = () => sessionDir

	const text = draft.loadDraft('04-test')

	expect(text).toBe('')
	expect(errors).toHaveLength(1)
	expect(errors[0]).toContain('[draft] load 04-test:')
})

test('clearDraft logs unexpected unlink failures and skips the draft_saved event', () => {
	const sessionDir = join(dir, '04-test')
	const badPath = join(sessionDir, 'draft.ason')
	mkdirSync(badPath, { recursive: true })
	const errors: string[] = []
	const events: any[] = []
	console.error = (...args: any[]) => {
		errors.push(args.join(' '))
	}
	ipc.appendEvent = (event: any) => {
		events.push(event)
	}
	sessions.sessionDir = () => sessionDir

	draft.clearDraft('04-test')

	expect(events).toHaveLength(0)
	expect(errors).toHaveLength(1)
	expect(errors[0]).toContain('[draft] clear 04-test:')
})
