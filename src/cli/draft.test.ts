import { test, expect } from 'bun:test'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { draft } from './draft.ts'
import { state } from '../state.ts'

const SESSION = '__draft_test__'

function setup() {
	const dir = state.sessionDir(SESSION)
	state.ensureDir(dir)
	return dir
}

test('saveDraft + loadDraft round-trip', async () => {
	setup()
	await draft.clearDraft(SESSION)
	await draft.saveDraft(SESSION, 'hello world')
	expect(await draft.loadDraft(SESSION)).toBe('hello world')
})

test('clearDraft removes draft file', async () => {
	setup()
	await draft.saveDraft(SESSION, 'something')
	await draft.clearDraft(SESSION)
	expect(await draft.loadDraft(SESSION)).toBe('')
})

test('saveDraft empty preserves existing draft', async () => {
	setup()
	await draft.saveDraft(SESSION, 'keep me')
	await draft.saveDraft(SESSION, '')
	expect(await draft.loadDraft(SESSION)).toBe('keep me')
})

test('saveDraft merges with existing draft from another client', async () => {
	setup()
	await draft.clearDraft(SESSION)
	await draft.saveDraft(SESSION, 'from client A')
	await draft.saveDraft(SESSION, 'from client B')
	expect(await draft.loadDraft(SESSION)).toBe('from client A\n\nfrom client B')
})

test('saveDraft does not merge duplicate text', async () => {
	setup()
	await draft.clearDraft(SESSION)
	await draft.saveDraft(SESSION, 'same text')
	await draft.saveDraft(SESSION, 'same text')
	expect(await draft.loadDraft(SESSION)).toBe('same text')
})

test('saveDraft copies /tmp/ images to session dir and rewrites paths', async () => {
	setup()
	await draft.clearDraft(SESSION)
	const tmpDir = '/tmp/hal/images'
	mkdirSync(tmpDir, { recursive: true })
	const tmpPath = `${tmpDir}/draft-test-${Date.now()}.png`
	writeFileSync(tmpPath, 'fake-png-data')

	await draft.saveDraft(SESSION, `look at this [${tmpPath}]`)

	const loaded = await draft.loadDraft(SESSION)
	const expectedDest = `${state.sessionDir(SESSION)}/images/${tmpPath.split('/').pop()}`
	expect(loaded).toBe(`look at this [${expectedDest}]`)
	expect(existsSync(expectedDest)).toBe(true)
})

test('saveDraft ignores non-tmp image paths', async () => {
	setup()
	await draft.clearDraft(SESSION)
	const text = 'see [~/Pictures/photo.png]'
	await draft.saveDraft(SESSION, text)
	expect(await draft.loadDraft(SESSION)).toBe(text)
})

test('saveDraft ignores missing tmp images', async () => {
	setup()
	await draft.clearDraft(SESSION)
	const text = 'see [/tmp/hal/images/nonexistent-9999.png]'
	await draft.saveDraft(SESSION, text)
	expect(await draft.loadDraft(SESSION)).toBe(text)
})
