import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { drafts, type Local } from '../common/drafts.ts'
import { draftFile } from './draft-file.ts'

let dir = ''
const origDir = draftFile.dir

beforeEach(() => {
	dir = mkdtempSync(`${tmpdir()}/hal-draft-file-`)
	draftFile.dir = () => `${dir}/drafts`
})

afterEach(() => {
	draftFile.dir = origDir
	rmSync(dir, { recursive: true, force: true })
})

test('a draft and its pending prompts survive into a new process', () => {
	let local: Local = { text: 'half\n"typed"', base: 4, dirty: true, sending: [{ id: 'a.1', text: 'sent' }] }
	draftFile.save('s1', local)
	expect(draftFile.load('s1')).toEqual(local)
})

test('nothing to keep leaves no file', () => {
	draftFile.save('s1', { text: 'x', base: 0, dirty: true, sending: [] })
	draftFile.save('s1', drafts.empty())
	expect(existsSync(draftFile.path('s1'))).toBe(false)
	expect(draftFile.load('s1')).toBeUndefined()
})

test('an unreadable file reads as no draft', () => {
	draftFile.save('s1', { text: 'x', base: 0, dirty: true, sending: [] })
	writeFileSync(draftFile.path('s1'), '{ text: ')
	expect(draftFile.load('s1')).toBeUndefined()
	writeFileSync(draftFile.path('s1'), '{ text: 3 }')
	expect(drafts.valid(draftFile.load('s1'))).toBeUndefined()
})
