import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import { runTool } from './tools.ts'
import { hashLine } from './hashline.ts'

const NOOP_LOGGER = () => {}

let tmpRoot = ''

beforeEach(() => {
	tmpRoot = mkdtempSync(resolve(tmpdir(), 'hal-tools-test-'))
})

afterEach(() => {
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
})

describe('tools', () => {
	test('write rejects directory path', async () => {
		const dirPath = `${tmpRoot}/subdir`
		mkdirSync(dirPath)

		const result = await runTool(
			'write',
			{ path: dirPath, content: 'hello' },
			{ cwd: tmpRoot, logger: NOOP_LOGGER },
		)

		expect(result).toContain('is a directory, not a file')
	})

	test('read rejects directory path', async () => {
		const dirPath = `${tmpRoot}/subdir`
		mkdirSync(dirPath)

		const result = await runTool(
			'read',
			{ path: dirPath },
			{ cwd: tmpRoot, logger: NOOP_LOGGER },
		)

		expect(result).toContain('is a directory, not a file')
	})

	test('input validation happens before filesystem operations', async () => {
		const filePath = `${tmpRoot}/should-not-exist.txt`

		const missingPathForRead = await runTool(
			'read',
			{},
			{ cwd: '/definitely/does/not/exist', logger: NOOP_LOGGER },
		)
		expect(missingPathForRead).toBe('error: read requires path')

		const missingPathForWrite = await runTool(
			'write',
			{ content: 'data' },
			{ cwd: tmpRoot, logger: NOOP_LOGGER },
		)
		expect(missingPathForWrite).toBe('error: write requires path')
		expect(existsSync(filePath)).toBe(false)

		const missingContentForWrite = await runTool(
			'write',
			{ path: filePath },
			{ cwd: tmpRoot, logger: NOOP_LOGGER },
		)
		expect(missingContentForWrite).toBe('error: write requires content')
		expect(existsSync(filePath)).toBe(false)
	})

	test('edit strips trailing newline from new_content', async () => {
		const filePath = `${tmpRoot}/edit.txt`
		writeFileSync(filePath, 'a\nb\nc')

		const ref = `2:${hashLine('b')}`
		const result = await runTool(
			'edit',
			{
				path: filePath,
				operation: 'replace',
				start_ref: ref,
				end_ref: ref,
				new_content: 'B\n',
			},
			{ cwd: tmpRoot, logger: NOOP_LOGGER },
		)

		expect(result).toContain('--- before')
		expect(readFileSync(filePath, 'utf-8')).toBe('a\nB\nc')
	})

	test('per-file lock serializes concurrent writes', async () => {
		const filePath = `${tmpRoot}/concurrent-write.txt`
		const contentA = `A:${'x'.repeat(100_000)}`
		const contentB = `B:${'y'.repeat(100_000)}`

		for (let i = 0; i < 8; i++) {
			const [r1, r2] = await Promise.all([
				runTool('write', { path: filePath, content: contentA }, { cwd: tmpRoot, logger: NOOP_LOGGER }),
				runTool('write', { path: filePath, content: contentB }, { cwd: tmpRoot, logger: NOOP_LOGGER }),
			])
			expect(r1).toBe('ok')
			expect(r2).toBe('ok')

			const finalContent = readFileSync(filePath, 'utf-8')
			expect(finalContent === contentA || finalContent === contentB).toBe(true)
		}
	})

	test('write and edit on same file are serialized', async () => {
		const filePath = `${tmpRoot}/write-edit.txt`
		const writeContent = 'WRITE\nBODY\nEND'
		writeFileSync(filePath, 'base\ntail')

		for (let i = 0; i < 8; i++) {
			writeFileSync(filePath, 'base\ntail')
			const [writeResult, editResult] = await Promise.all([
				runTool(
					'write',
					{ path: filePath, content: writeContent },
					{ cwd: tmpRoot, logger: NOOP_LOGGER },
				),
				runTool(
					'edit',
					{
						path: filePath,
						operation: 'insert',
						after_ref: '0:000',
						new_content: 'HEADER\n',
					},
					{ cwd: tmpRoot, logger: NOOP_LOGGER },
				),
			])

			expect(writeResult).toBe('ok')
			expect(editResult).toContain('--- before')

			const finalContent = readFileSync(filePath, 'utf-8')
			expect(
				finalContent === writeContent || finalContent === `HEADER\n${writeContent}`,
			).toBe(true)
		}
	})
})
