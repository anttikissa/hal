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

test('parseUserContent inlines [path.txt] from /tmp/hal/', async () => {
	const txtPath = '/tmp/hal/test-paste.txt'
	mkdirSync('/tmp/hal', { recursive: true })
	writeFileSync(txtPath, 'line one\nline two\nline three')
	try {
		const { apiContent, logContent } = await parseUserContent(TEST_SESSION, `check this [${txtPath}]`)
		expect(Array.isArray(apiContent)).toBe(true)
		expect(apiContent).toHaveLength(2)
		expect(apiContent[0]).toEqual({ type: 'text', text: 'check this ' })
		expect(apiContent[1]).toEqual({ type: 'text', text: 'line one\nline two\nline three' })
		// Log keeps the path reference
		expect(Array.isArray(logContent)).toBe(true)
		expect((logContent as any[])[1]).toEqual({ type: 'text', text: `[${txtPath}]` })
	} finally {
		rmSync(txtPath)
	}
})

test('parseUserContent does not expand .txt outside /tmp/hal/', async () => {
	const { apiContent } = await parseUserContent(TEST_SESSION, 'read [/etc/passwd.txt]')
	expect(apiContent).toBe('read [/etc/passwd.txt]')
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

test('loadApiMessages synthesizes results for orphaned tool_use blocks', async () => {
	const { writeAssistantEntry, writeToolResultEntry } = await import('./messages.ts')
	const SID = TEST_SESSION

	// User message
	await appendMessages(SID, [{ role: 'user', content: 'do stuff', ts: new Date().toISOString() }])

	// Assistant with 2 tool calls, only 1 gets a result
	const { entry, toolRefMap } = await writeAssistantEntry(SID, {
		text: 'ok',
		toolCalls: [
			{ id: 't1', name: 'bash', input: { command: 'ls' } },
			{ id: 't2', name: 'read', input: { path: 'x' } },
		],
	})
	await appendMessages(SID, [entry])

	// Only write result for t1
	const r1 = await writeToolResultEntry(SID, 't1', 'file.txt', toolRefMap)
	await appendMessages(SID, [r1])

	// Another assistant with tool call, no result at all
	const { entry: entry2 } = await writeAssistantEntry(SID, {
		toolCalls: [{ id: 't3', name: 'bash', input: { command: 'pwd' } }],
	})
	await appendMessages(SID, [entry2])

	// User message after the mess
	await appendMessages(SID, [{ role: 'user', content: 'hello', ts: new Date().toISOString() }])

	const msgs = await loadApiMessages(SID)

	// Every tool_use must have a matching tool_result
	const allToolUseIds = new Set<string>()
	const allToolResultIds = new Set<string>()
	for (const m of msgs) {
		if (!Array.isArray(m.content)) continue
		for (const b of m.content) {
			if (b.type === 'tool_use') allToolUseIds.add(b.id)
			if (b.type === 'tool_result') allToolResultIds.add(b.tool_use_id)
		}
	}
	for (const id of allToolUseIds) {
		expect(allToolResultIds.has(id)).toBe(true)
	}

	// Last message should be the user 'hello'
	expect(msgs[msgs.length - 1].role).toBe('user')
	expect(msgs[msgs.length - 1].content).toBe('hello')
})
