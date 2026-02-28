import { describe, test, expect, afterAll } from 'bun:test'
import { existsSync, rmSync } from 'fs'
import { saveDraft, loadDraft, replayConversationEvents } from './session.ts'
import { sessionDir } from './state.ts'

// Use unique session IDs to avoid collisions with real sessions
const TEST_IDS = ['s-drafttest1', 's-drafttest2', 's-drafttest3']

afterAll(() => {
	for (const id of TEST_IDS) {
		try { rmSync(sessionDir(id), { recursive: true, force: true }) } catch {}
	}
})

describe('draft persistence', () => {
	test('save and load draft', async () => {
		await saveDraft(TEST_IDS[0], 'hello world')
		const draft = await loadDraft(TEST_IDS[0])
		expect(draft).toBe('hello world')
	})

	test('empty draft removes file', async () => {
		await saveDraft(TEST_IDS[1], 'some text')
		expect(existsSync(`${sessionDir(TEST_IDS[1])}/draft.txt`)).toBe(true)

		await saveDraft(TEST_IDS[1], '')
		expect(existsSync(`${sessionDir(TEST_IDS[1])}/draft.txt`)).toBe(false)
	})

	test('load missing draft returns empty string', async () => {
		const draft = await loadDraft('s-nonexistent')
		expect(draft).toBe('')
	})

	test('multiline draft roundtrips', async () => {
		const text = 'line 1\nline 2\nline 3'
		await saveDraft(TEST_IDS[2], text)
		expect(await loadDraft(TEST_IDS[2])).toBe(text)
	})
})
describe('conversation replay slicing', () => {
	test('keeps only user/assistant events after last reset', () => {
		const replay = replayConversationEvents([
			{ type: 'user', text: 'old', ts: '1' },
			{ type: 'assistant', text: 'old reply', ts: '2' },
			{ type: 'model', from: 'a', to: 'b', ts: '3' },
			{ type: 'reset', ts: '4' },
			{ type: 'cd', from: '/a', to: '/b', ts: '5' },
			{ type: 'user', text: 'new', ts: '6' },
			{ type: 'assistant', text: 'new reply', ts: '7' },
		])
		expect(replay).toEqual([
			{ type: 'user', text: 'new', ts: '6' },
			{ type: 'assistant', text: 'new reply', ts: '7' },
		])
	})

	test('keeps only user/assistant events after last handoff', () => {
		const replay = replayConversationEvents([
			{ type: 'user', text: 'before', ts: '1' },
			{ type: 'assistant', text: 'before reply', ts: '2' },
			{ type: 'handoff', ts: '3' },
			{ type: 'topic', to: 'x', ts: '4' },
			{ type: 'user', text: 'after', ts: '5' },
		])
		expect(replay).toEqual([{ type: 'user', text: 'after', ts: '5' }])
	})
})
