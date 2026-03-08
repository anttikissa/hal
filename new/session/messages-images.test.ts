import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { parseUserContent, readMessages, appendMessages, loadApiMessages } from './messages.ts'

const TEST_SESSION = '__test_img_session'
const TEST_IMAGE = '/tmp/hal-test-img.png'
const STATE_DIR = process.env.HAL_STATE_DIR || `${process.env.HAL_DIR || process.env.HOME + '/.hal'}/state`

beforeEach(() => {
	// Create a tiny valid PNG (1x1 red pixel)
	const png = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
		'base64',
	)
	writeFileSync(TEST_IMAGE, png)
})

afterEach(() => {
	if (existsSync(TEST_IMAGE)) rmSync(TEST_IMAGE)
	const dir = `${STATE_DIR}/sessions/${TEST_SESSION}`
	if (existsSync(dir)) rmSync(dir, { recursive: true })
})

test('parseUserContent returns plain string when no images', async () => {
	const { apiContent, logContent } = await parseUserContent(TEST_SESSION, 'hello world')
	expect(apiContent).toBe('hello world')
	expect(logContent).toBe('hello world')
})

test('parseUserContent parses [path.png] into image blocks', async () => {
	const { apiContent, logContent } = await parseUserContent(TEST_SESSION, `describe this [${TEST_IMAGE}]`)
	expect(Array.isArray(apiContent)).toBe(true)
	expect(apiContent).toHaveLength(2)
	expect(apiContent[0]).toEqual({ type: 'text', text: 'describe this ' })
	expect(apiContent[1].type).toBe('image')
	expect(apiContent[1].source.type).toBe('base64')
	expect(apiContent[1].source.media_type).toBe('image/png')

	// Log content should have ref instead of base64
	expect(Array.isArray(logContent)).toBe(true)
	const imgBlock = (logContent as any[]).find((b: any) => b.type === 'image')
	expect(imgBlock.ref).toBeDefined()
	expect(imgBlock.source).toBeUndefined()
})

test('parseUserContent handles missing file', async () => {
	const { apiContent } = await parseUserContent(TEST_SESSION, '[/nonexistent/image.png]')
	expect(Array.isArray(apiContent)).toBe(true)
	expect(apiContent[0].type).toBe('text')
	expect(apiContent[0].text).toContain('file not found')
})

test('image blocks round-trip through loadApiMessages', async () => {
	const { logContent } = await parseUserContent(TEST_SESSION, `look [${TEST_IMAGE}]`)
	await appendMessages(TEST_SESSION, [{ role: 'user', content: logContent, ts: new Date().toISOString() }])

	const apiMessages = await loadApiMessages(TEST_SESSION)
	expect(apiMessages).toHaveLength(1)
	expect(apiMessages[0].role).toBe('user')
	const content = apiMessages[0].content
	expect(Array.isArray(content)).toBe(true)
	const imgBlock = content.find((b: any) => b.type === 'image')
	expect(imgBlock.source.type).toBe('base64')
	expect(imgBlock.source.media_type).toBe('image/png')
	expect(imgBlock.source.data).toBeTruthy()
})
