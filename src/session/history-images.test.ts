import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { readHistory, appendHistory, loadApiMessages, history } from './history.ts'
import { attachments } from './attachments.ts'

const TEST_SESSION = '__test_img_session'
const TEST_IMAGE = '/tmp/hal-test-img.png'
const STATE_DIR = process.env.HAL_STATE_DIR || `${process.env.HAL_DIR || process.env.HOME + '/.hal'}/state`

const defaultConfig = { ...history.config }

beforeEach(() => {
	// Create a tiny valid PNG (1x1 red pixel)
	const png = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
		'base64',
	)
	writeFileSync(TEST_IMAGE, png)
})

afterEach(() => {
	Object.assign(history.config, defaultConfig)
	if (existsSync(TEST_IMAGE)) rmSync(TEST_IMAGE)
	const dir = `${STATE_DIR}/sessions/${TEST_SESSION}`
	if (existsSync(dir)) rmSync(dir, { recursive: true })
})

test('attachments.resolve returns plain string when no images', async () => {
	const { apiContent, logContent } = await attachments.resolve(TEST_SESSION, 'hello world')
	expect(apiContent).toBe('hello world')
	expect(logContent).toBe('hello world')
})

test('attachments.resolve parses [path.png] into image blocks', async () => {
	const { apiContent, logContent } = await attachments.resolve(TEST_SESSION, `describe this [${TEST_IMAGE}]`)
	expect(Array.isArray(apiContent)).toBe(true)
	expect(apiContent).toHaveLength(2)
	expect(apiContent[0]).toEqual({ type: 'text', text: 'describe this ' })
	expect(apiContent[1].type).toBe('image')
	expect(apiContent[1].source.type).toBe('base64')
	expect(apiContent[1].source.media_type).toBe('image/png')

	// Log content should have blob id instead of base64
	expect(Array.isArray(logContent)).toBe(true)
	const imgBlock = (logContent as any[]).find((b: any) => b.type === 'image')
	expect(imgBlock.blobId).toBeDefined()
	expect(imgBlock.source).toBeUndefined()
})

test('attachments.resolve handles missing file', async () => {
	const { apiContent } = await attachments.resolve(TEST_SESSION, '[/nonexistent/image.png]')
	expect(Array.isArray(apiContent)).toBe(true)
	expect(apiContent[0].type).toBe('text')
	expect(apiContent[0].text).toContain('file not found')
})

test('attachments.resolve inlines [path.txt] from /tmp/hal/', async () => {
	const txtPath = '/tmp/hal/test-paste.txt'
	mkdirSync('/tmp/hal', { recursive: true })
	writeFileSync(txtPath, 'line one\nline two\nline three')
	try {
		const { apiContent, logContent } = await attachments.resolve(TEST_SESSION, `check this [${txtPath}]`)
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

test('attachments.resolve does not expand .txt outside /tmp/hal/', async () => {
	const { apiContent } = await attachments.resolve(TEST_SESSION, 'read [/etc/passwd.txt]')
	expect(apiContent).toBe('read [/etc/passwd.txt]')
})

test('image blocks round-trip through loadApiMessages', async () => {
	const { logContent } = await attachments.resolve(TEST_SESSION, `look [${TEST_IMAGE}]`)
	await appendHistory(TEST_SESSION, [{ role: 'user', content: logContent, ts: new Date().toISOString() }])

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
	const { writeAssistantEntry, writeToolResultEntry } = await import('./history.ts')
	const SID = TEST_SESSION

	// User message
	await appendHistory(SID, [{ role: 'user', content: 'do stuff', ts: new Date().toISOString() }])

	// Assistant with 2 tool calls, only 1 gets a result
	const { entry, toolBlobMap } = await writeAssistantEntry(SID, {
		text: 'ok',
		toolCalls: [
			{ id: 't1', name: 'bash', input: { command: 'ls' } },
			{ id: 't2', name: 'read', input: { path: 'x' } },
		],
	})
	await appendHistory(SID, [entry])

	// Only write result for t1
	const r1 = await writeToolResultEntry(SID, 't1', 'file.txt', toolBlobMap)
	await appendHistory(SID, [r1])

	// Another assistant with tool call, no result at all
	const { entry: entry2 } = await writeAssistantEntry(SID, {
		toolCalls: [{ id: 't3', name: 'bash', input: { command: 'pwd' } }],
	})
	await appendHistory(SID, [entry2])

	// User message after the mess
	await appendHistory(SID, [{ role: 'user', content: 'hello', ts: new Date().toISOString() }])

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

test('loadApiMessages includes thinking blocks with signature', async () => {
	const SID = TEST_SESSION
	await appendHistory(SID, [{ role: 'user', content: 'hello', ts: new Date().toISOString() }])
	await appendHistory(SID, [{
		role: 'assistant', text: 'hi', thinkingText: 'let me think...',
		thinkingSignature: 'sig123', ts: new Date().toISOString(),
	}])

	const msgs = await loadApiMessages(SID)
	expect(msgs).toHaveLength(2)
	const assistant = msgs[1]
	expect(assistant.role).toBe('assistant')
	expect(assistant.content[0]).toEqual({ type: 'thinking', thinking: 'let me think...', signature: 'sig123' })
	expect(assistant.content[1]).toEqual({ type: 'text', text: 'hi' })
})

test('loadApiMessages omits thinking blocks without signature', async () => {
	const SID = TEST_SESSION
	await appendHistory(SID, [{ role: 'user', content: 'hello', ts: new Date().toISOString() }])
	await appendHistory(SID, [{
		role: 'assistant', text: 'hi', thinkingText: 'old thinking without sig',
		ts: new Date().toISOString(),
	}])

	const msgs = await loadApiMessages(SID)
	expect(msgs).toHaveLength(2)
	const assistant = msgs[1]
	expect(assistant.content).toHaveLength(1)
	expect(assistant.content[0]).toEqual({ type: 'text', text: 'hi' })
})

test('replay marks tool with error status when stored result status is error', async () => {
	const { writeAssistantEntry, writeToolResultEntry } = await import('./history.ts')
	const { replayToBlocks } = await import('./replay.ts')
	const SID = TEST_SESSION

	const { entry, toolBlobMap } = await writeAssistantEntry(SID, {
		text: 'run',
		toolCalls: [{ id: 't1', name: 'read', input: { path: 'missing.txt' } }],
	})
	await appendHistory(SID, [entry])
	const result = await writeToolResultEntry(SID, 't1', 'error: file not found', toolBlobMap, 'error')
	await appendHistory(SID, [result])

	const messages = await readHistory(SID)
	const blocks = await replayToBlocks(SID, messages)
	const tool = blocks.find((b: any) => b.type === 'tool') as any
	expect(tool).toBeTruthy()
	expect(tool.status).toBe('error')
})

test('loadApiMessages boosts threshold after model change', async () => {
	const { writeAssistantEntry, writeToolResultEntry } = await import('./history.ts')
	const SID = TEST_SESSION

	// User + tool cycle
	await appendHistory(SID, [{ role: 'user', content: 'go', ts: new Date().toISOString() }])
	const { entry, toolBlobMap } = await writeAssistantEntry(SID, {
		text: 'ok',
		toolCalls: [{ id: 't0', name: 'bash', input: { command: 'ls' } }],
	})
	await appendHistory(SID, [entry])
	const result = await writeToolResultEntry(SID, 't0', 'file1.ts\nfile2.ts', toolBlobMap)
	await appendHistory(SID, [result])

	// Model change
	await appendHistory(SID, [{ type: 'info', text: '[model] anthropic/claude-opus-4-6', level: 'meta', ts: new Date().toISOString() }])

	// 6 plain user turns after model change — beyond default threshold (4) but within boosted (10)
	for (let i = 0; i < 6; i++) {
		await appendHistory(SID, [
			{ role: 'user', content: `question ${i}`, ts: new Date().toISOString() },
			{ role: 'assistant', text: `answer ${i}`, ts: new Date().toISOString() },
		])
	}

	const msgs = await loadApiMessages(SID)

	// Tool result should be kept (threshold boosted to 10 due to model change)
	const toolResultMsg = msgs.find((m: any) =>
		m.role === 'user' && Array.isArray(m.content) &&
		m.content.some((b: any) => b.type === 'tool_result')
	)
	expect(toolResultMsg).toBeTruthy()
	const toolResult = toolResultMsg.content.find((b: any) => b.type === 'tool_result')
	expect(toolResult.content).toBe('file1.ts\nfile2.ts')
})


test('loadApiMessages uses live maxApiOutput config', async () => {
	const { writeAssistantEntry, writeToolResultEntry } = await import('./history.ts')
	const SID = TEST_SESSION

	await appendHistory(SID, [{ role: 'user', content: 'go', ts: new Date().toISOString() }])
	const { entry, toolBlobMap } = await writeAssistantEntry(SID, {
		text: 'ok',
		toolCalls: [{ id: 't0', name: 'bash', input: { command: 'cat huge.txt' } }],
	})
	await appendHistory(SID, [entry])
	await appendHistory(SID, [await writeToolResultEntry(SID, 't0', 'abcdefghij', toolBlobMap)])

	history.config.maxApiOutput = 4
	const msgs = await loadApiMessages(SID)
	const toolResultMsg = msgs.find((m: any) =>
		m.role === 'user' && Array.isArray(m.content) &&
		m.content.some((b: any) => b.type === 'tool_result')
	)
	const toolResult = toolResultMsg.content.find((b: any) => b.type === 'tool_result')
	expect(toolResult.content).toBe('abcd\n[truncated 6 chars]')
})