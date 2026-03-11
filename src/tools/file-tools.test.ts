import { test, expect, afterEach } from 'bun:test'
import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { read } from './read.ts'
import { write } from './write.ts'
import { edit } from './edit.ts'

const TMP_DIR = `/tmp/hal-file-tools-${process.pid}`

afterEach(() => {
	try { rmSync(TMP_DIR, { recursive: true, force: true }) } catch {}
})

test('read executes with hashline output', async () => {
	mkdirSync(TMP_DIR, { recursive: true })
	const path = join(TMP_DIR, 'read.txt')
	writeFileSync(path, 'one\ntwo\n')
	const result = await read.execute({ path }, { cwd: TMP_DIR })
	expect(result).toContain('1:')
	expect(result).toContain('one')
	expect(result).toContain('two')
})

test('write resolves relative paths from cwd', async () => {
	mkdirSync(TMP_DIR, { recursive: true })
	const result = await write.execute({ path: 'note.txt', content: 'hello' }, { cwd: TMP_DIR })
	expect(result).toBe('ok')
	expect(readFileSync(join(TMP_DIR, 'note.txt'), 'utf-8')).toBe('hello')
})

test('edit replace verifies refs and writes content', async () => {
	mkdirSync(TMP_DIR, { recursive: true })
	const path = join(TMP_DIR, 'edit.txt')
	writeFileSync(path, 'aaa\nbbb\nccc\n')
	const readResult = await read.execute({ path }, { cwd: TMP_DIR })
	const lines = readResult.split('\n')
	const ref2 = lines[1].split(' ')[0]
	const result = await edit.execute(
		{
			path,
			operation: 'replace',
			start_ref: ref2,
			end_ref: ref2,
			new_content: 'BBB',
		},
		{ cwd: TMP_DIR, contextLines: 3 },
	)
	expect(result).toContain('+++ after')
	expect(readFileSync(path, 'utf-8')).toBe('aaa\nBBB\nccc\n')
})
