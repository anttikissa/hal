import { expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { sessions } from '../src/server/sessions.ts'
import { draft } from '../src/cli/draft.ts'
import { ason } from '../src/utils/ason.ts'

const TEST_SESSION = '__draft_test__'

beforeEach(() => {
	const dir = sessions.sessionDir(TEST_SESSION)
	mkdirSync(dir, { recursive: true })
})

afterEach(() => {
	const dir = sessions.sessionDir(TEST_SESSION)
	rmSync(dir, { recursive: true, force: true })
})

test('saveDraft + loadDraft round-trip', () => {
	draft.saveDraft(TEST_SESSION, 'hello world')
	expect(draft.loadDraft(TEST_SESSION)).toBe('hello world')
})

test('saveDraft writes ason with savedAt timestamp', () => {
	draft.saveDraft(TEST_SESSION, 'test text')
	const path = `${sessions.sessionDir(TEST_SESSION)}/draft.ason`
	expect(existsSync(path)).toBe(true)
	const data = ason.parse(readFileSync(path, 'utf-8')) as any
	expect(data.text).toBe('test text')
	expect(typeof data.savedAt).toBe('string')
	// savedAt should be a valid ISO date
	expect(isNaN(Date.parse(data.savedAt))).toBe(false)
})

test('clearDraft removes draft file', () => {
	draft.saveDraft(TEST_SESSION, 'something')
	draft.clearDraft(TEST_SESSION)
	expect(draft.loadDraft(TEST_SESSION)).toBe('')
})

test('saveDraft empty string clears existing draft', () => {
	draft.saveDraft(TEST_SESSION, 'keep me')
	draft.saveDraft(TEST_SESSION, '')
	expect(draft.loadDraft(TEST_SESSION)).toBe('')
})

test('saveDraft overwrites existing draft', () => {
	draft.saveDraft(TEST_SESSION, 'first')
	draft.saveDraft(TEST_SESSION, 'second')
	expect(draft.loadDraft(TEST_SESSION)).toBe('second')
})

test('loadDraft returns empty for nonexistent session', () => {
	expect(draft.loadDraft('__nonexistent_session__')).toBe('')
})

test('multiline draft survives round-trip', () => {
	const text = 'line 1\nline 2\nline 3'
	draft.saveDraft(TEST_SESSION, text)
	expect(draft.loadDraft(TEST_SESSION)).toBe(text)
})
