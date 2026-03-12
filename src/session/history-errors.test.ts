import { test, expect, afterEach } from 'bun:test'
import { rmSync, existsSync } from 'fs'
import { appendHistory, loadApiMessages, history } from './history.ts'

const TEST_SESSION = '__test_error_session'
const STATE_DIR = process.env.HAL_STATE_DIR || `${process.env.HAL_DIR || process.env.HOME + '/.hal'}/state`

const defaultConfig = { ...history.config }

afterEach(() => {
	Object.assign(history.config, defaultConfig)
	const dir = `${STATE_DIR}/sessions/${TEST_SESSION}`
	if (existsSync(dir)) rmSync(dir, { recursive: true })
})

test('loadApiMessages injects error info into following user message', async () => {
	const SID = TEST_SESSION
	const ts = () => new Date().toISOString()

	// assistant response
	await appendHistory(SID, [{ role: 'user', content: 'do something', ts: ts() }])
	await appendHistory(SID, [{ role: 'assistant', text: 'done', ts: ts() }])

	// error happens (e.g. /cd fails)
	await appendHistory(SID, [{ type: 'info', text: '[cd] /bad/path: not found', level: 'error', ts: ts() }])

	// user refers to the error
	await appendHistory(SID, [{ role: 'user', content: 'fix that cd error', ts: ts() }])

	const msgs = await loadApiMessages(SID)
	const lastUser = msgs[msgs.length - 1]
	expect(lastUser.role).toBe('user')
	expect(lastUser.content).toContain('[cd] /bad/path: not found')
	expect(lastUser.content).toContain('fix that cd error')
})

test('loadApiMessages injects warn info into following user message', async () => {
	const SID = TEST_SESSION
	const ts = () => new Date().toISOString()

	await appendHistory(SID, [{ role: 'user', content: 'hi', ts: ts() }])
	await appendHistory(SID, [{ role: 'assistant', text: 'hello', ts: ts() }])
	await appendHistory(SID, [{ type: 'info', text: 'Session is busy', level: 'warn', ts: ts() }])
	await appendHistory(SID, [{ role: 'user', content: 'why?', ts: ts() }])

	const msgs = await loadApiMessages(SID)
	const lastUser = msgs[msgs.length - 1]
	expect(lastUser.content).toContain('Session is busy')
	expect(lastUser.content).toContain('why?')
})

test('error infos expire after 3 user turns', async () => {
	const SID = TEST_SESSION
	const ts = () => new Date().toISOString()

	await appendHistory(SID, [{ role: 'user', content: 'start', ts: ts() }])
	await appendHistory(SID, [{ role: 'assistant', text: 'ok', ts: ts() }])
	await appendHistory(SID, [{ type: 'info', text: 'old error', level: 'error', ts: ts() }])

	// 3 more user/assistant turns
	for (let i = 0; i < 3; i++) {
		await appendHistory(SID, [{ role: 'user', content: `turn ${i}`, ts: ts() }])
		await appendHistory(SID, [{ role: 'assistant', text: `reply ${i}`, ts: ts() }])
	}

	await appendHistory(SID, [{ role: 'user', content: 'latest', ts: ts() }])

	const msgs = await loadApiMessages(SID)
	// The old error should NOT appear in any message
	const allText = msgs.map((m: any) => JSON.stringify(m.content)).join(' ')
	expect(allText).not.toContain('old error')
})

test('error within 3 user turns is still included', async () => {
	const SID = TEST_SESSION
	const ts = () => new Date().toISOString()

	await appendHistory(SID, [{ role: 'user', content: 'start', ts: ts() }])
	await appendHistory(SID, [{ role: 'assistant', text: 'ok', ts: ts() }])
	await appendHistory(SID, [{ type: 'info', text: 'recent error', level: 'error', ts: ts() }])

	// 2 turns (within the 3-turn window)
	for (let i = 0; i < 2; i++) {
		await appendHistory(SID, [{ role: 'user', content: `turn ${i}`, ts: ts() }])
		await appendHistory(SID, [{ role: 'assistant', text: `reply ${i}`, ts: ts() }])
	}

	await appendHistory(SID, [{ role: 'user', content: 'check', ts: ts() }])

	const msgs = await loadApiMessages(SID)
	const allText = msgs.map((m: any) => JSON.stringify(m.content)).join(' ')
	expect(allText).toContain('recent error')
})

test('multiple errors before a user message are all injected', async () => {
	const SID = TEST_SESSION
	const ts = () => new Date().toISOString()

	await appendHistory(SID, [{ role: 'user', content: 'hi', ts: ts() }])
	await appendHistory(SID, [{ role: 'assistant', text: 'hello', ts: ts() }])
	await appendHistory(SID, [{ type: 'info', text: 'error one', level: 'error', ts: ts() }])
	await appendHistory(SID, [{ type: 'info', text: 'error two', level: 'error', ts: ts() }])
	await appendHistory(SID, [{ role: 'user', content: 'what happened?', ts: ts() }])

	const msgs = await loadApiMessages(SID)
	const lastUser = msgs[msgs.length - 1]
	expect(lastUser.content).toContain('error one')
	expect(lastUser.content).toContain('error two')
	expect(lastUser.content).toContain('what happened?')
})

test('error before array content user message is injected as text block', async () => {
	const SID = TEST_SESSION
	const ts = () => new Date().toISOString()

	await appendHistory(SID, [{ role: 'user', content: 'hi', ts: ts() }])
	await appendHistory(SID, [{ role: 'assistant', text: 'hello', ts: ts() }])
	await appendHistory(SID, [{ type: 'info', text: 'some error', level: 'error', ts: ts() }])
	await appendHistory(SID, [{ role: 'user', content: [{ type: 'text', text: 'look at this' }], ts: ts() }])

	const msgs = await loadApiMessages(SID)
	const lastUser = msgs[msgs.length - 1]
	expect(Array.isArray(lastUser.content)).toBe(true)
	const texts = lastUser.content.filter((b: any) => b.type === 'text').map((b: any) => b.text)
	expect(texts.some((t: string) => t.includes('some error'))).toBe(true)
	expect(texts.some((t: string) => t.includes('look at this'))).toBe(true)
})

test('meta-level info entries ARE injected into user messages', async () => {
	const SID = TEST_SESSION
	const ts = () => new Date().toISOString()

	await appendHistory(SID, [{ role: 'user', content: 'hi', ts: ts() }])
	await appendHistory(SID, [{ role: 'assistant', text: 'hello', ts: ts() }])
	await appendHistory(SID, [{ type: 'info', text: '[cd] /old → /new', level: 'meta', ts: ts() }])
	await appendHistory(SID, [{ role: 'user', content: 'next question', ts: ts() }])

	const msgs = await loadApiMessages(SID)
	const lastUser = msgs[msgs.length - 1]
	expect(lastUser.content).toContain('[cd] /old → /new')
	expect(lastUser.content).toContain('next question')
})

test('analysis-level info entries are NOT injected into user messages', async () => {
	const SID = TEST_SESSION
	const ts = () => new Date().toISOString()

	await appendHistory(SID, [{ role: 'user', content: 'hi', ts: ts() }])
	await appendHistory(SID, [{ role: 'assistant', text: 'hello', ts: ts() }])
	await appendHistory(SID, [{ type: 'info', text: '[analysis] neutral topic=...', level: 'info', ts: ts() }])
	await appendHistory(SID, [{ role: 'user', content: 'next question', ts: ts() }])

	const msgs = await loadApiMessages(SID)
	const allText = msgs.map((m: any) => JSON.stringify(m.content)).join(' ')
	expect(allText).not.toContain('[analysis]')
})
