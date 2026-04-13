import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { attachments } from './attachments.ts'
import { blob } from './blob.ts'
import { sessions } from '../server/sessions.ts'

// We need a real session dir for blob storage. Use a temp location.
const TEST_SESSION = 'test-attach'
const TEST_DIR = `/tmp/hal-test-attachments`
const SESSION_DIR = `${TEST_DIR}/sessions/${TEST_SESSION}`

describe('attachments.resolve', () => {
	beforeEach(() => {
		// Point sessions.sessionDir at our test dir
		const orig = sessions.sessionDir
		sessions.sessionDir = (id: string) => `${TEST_DIR}/sessions/${id}`

		mkdirSync(`${SESSION_DIR}/blobs`, { recursive: true })
		// Write a minimal session.ason so blob ID generation works
		writeFileSync(`${SESSION_DIR}/session.ason`, `{ createdAt: "${new Date().toISOString()}" }\n`)
	})

	afterEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
	})

	test('plain text without attachments passes through unchanged', async () => {
		const result = await attachments.resolve(TEST_SESSION, 'hello world')
		expect(result.apiContent).toBe('hello world')
		expect(result.logParts).toEqual([{ type: 'text', text: 'hello world' }])
	})

	test('image reference is resolved to base64 content block', async () => {
		// Create a test image file (1x1 red PNG)
		const imgPath = `${TEST_DIR}/test.png`
		// Minimal valid PNG (1x1 pixel)
		const pngBuf = Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
			'base64',
		)
		writeFileSync(imgPath, pngBuf)

		const result = await attachments.resolve(TEST_SESSION, `look at this [${imgPath}]`)

		// API content should be an array with text + image blocks
		expect(Array.isArray(result.apiContent)).toBe(true)
		const apiBlocks = result.apiContent as any[]
		expect(apiBlocks.some((b: any) => b.type === 'text' && b.text.includes('look at this'))).toBe(true)
		expect(apiBlocks.some((b: any) => b.type === 'image' && b.source?.type === 'base64')).toBe(true)

		// Log history should have a blob reference, not raw base64
		expect(Array.isArray(result.logParts)).toBe(true)
		expect(result.logParts.some((b: any) => b.type === 'image' && b.blobId)).toBe(true)
	})

	test('missing file produces error text block', async () => {
		const result = await attachments.resolve(TEST_SESSION, `see [/nonexistent/foo.png]`)

		expect(Array.isArray(result.apiContent)).toBe(true)
		const apiBlocks = result.apiContent as any[]
		expect(apiBlocks.some((b: any) => b.type === 'text' && b.text.includes('file not found'))).toBe(true)
	})
})
