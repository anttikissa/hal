// Integration test — runtime + IPC end-to-end.

import { writeFileSync, rmSync, existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { randomBytes } from 'crypto'
import type { Runtime } from './runtime.ts'
import type { RuntimeEvent } from '../protocol.ts'

const TEST_CONFIG = `/tmp/hal-test-config-${process.pid}.ason`
writeFileSync(TEST_CONFIG, '{ defaultModel: "mock/mock-1" }\n')
process.env.HAL_CONFIG = TEST_CONFIG

const stateMod = await import('../state.ts')
const ipcMod = await import('../ipc.ts')
const runtimeMod = await import('./runtime.ts')
const protocolMod = await import('../protocol.ts')
const aSonMod = await import('../utils/ason.ts')
const messagesMod = await import('../session/messages.ts')
const sessionMod = await import('../session/session.ts')

const { ensureStateDir, STATE_DIR, sessionDir } = stateMod
const { ensureBus, claimHost, releaseHost, commands, events, updateState } = ipcMod
const { startRuntime } = runtimeMod
const { makeCommand } = protocolMod
const { parseAll } = aSonMod
const { appendMessages, writeAssistantEntry } = messagesMod
const { createSession } = sessionMod

if (!STATE_DIR.includes('/hal-new-test-')) {
	throw new Error(`runtime.test state isolation failed: STATE_DIR=${STATE_DIR}`)
}

const src = { kind: 'cli' as const, clientId: 'test' }

let hostId: string
let runtime: Runtime

beforeEach(async () => {
	if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true })
	ensureStateDir()
	await ensureBus()
	hostId = `${process.pid}-${randomBytes(4).toString('hex')}`
	await claimHost(hostId)
	runtime = await startRuntime()
	// Wait for greeting generation to finish
	await new Promise(r => setTimeout(r, 300))
})

afterEach(async () => {
	runtime.stop()
	await releaseHost(hostId)
	await new Promise(r => setTimeout(r, 100))
})

afterAll(() => {
	rmSync(STATE_DIR, { recursive: true, force: true })
	rmSync(TEST_CONFIG, { force: true })
})

async function sendAndWait(text: string, sid?: string): Promise<RuntimeEvent[]> {
	const snapshot = (await events.readAll()).length
	const sessionId = sid ?? runtime.activeSessionId!
	await commands.append(makeCommand('prompt', src, text, sessionId))
	for (let i = 0; i < 200; i++) {
		await new Promise(r => setTimeout(r, 50))
		const all = await events.readAll()
		const recent = all.slice(snapshot)
		const done = recent.find(e => e.type === 'command' && (e.phase === 'done' || e.phase === 'failed'))
		if (done) return recent
	}
	throw new Error('Timed out waiting for response')
}

test('runtime creates a session on startup', () => {
	expect(runtime.activeSessionId).toBeTruthy()
	expect(runtime.sessions.size).toBe(1)
})

test('prompt produces thinking + assistant chunks + done', async () => {
	const events = await sendAndWait('Hello world')
	const thinking = events.filter(e => e.type === 'chunk' && e.channel === 'thinking')
	const assistant = events.filter(e => e.type === 'chunk' && e.channel === 'assistant')
	const done = events.find(e => e.type === 'command' && e.phase === 'done')

	expect(thinking.length).toBeGreaterThan(0)
	expect(assistant.length).toBeGreaterThan(0)
	expect(done).toBeTruthy()
})

test('prompt is echoed back as a prompt event', async () => {
	const events = await sendAndWait('Test prompt')
	const prompt = events.find(e => e.type === 'prompt')
	expect(prompt).toBeTruthy()
	if (prompt?.type === 'prompt') {
		expect(prompt.text).toBe('Test prompt')
	}
})

test('messages are persisted to disk', async () => {
	await sendAndWait('Persist me')
	const sid = runtime.activeSessionId!
	const path = `${sessionDir(sid)}/messages.asonl`
	expect(existsSync(path)).toBe(true)
	const raw = await readFile(path, 'utf-8')
	const entries = parseAll(raw) as any[]
	const user = entries.find(e => e.role === 'user')
	// Skip greeting — find the assistant response to the prompt
	const assistant = entries.find(e => e.role === 'assistant' && e.text?.includes('Persist me'))
	expect(user?.content).toBe('Persist me')
	expect(assistant).toBeTruthy()
})

test('status events bracket the generation', async () => {
	const events = await sendAndWait('Status test')
	const statuses = events.filter(e => e.type === 'status') as any[]
	const busyOn = statuses.find(s => s.busy)
	const busyOff = statuses.find(s => !s.busy)
	expect(busyOn).toBeTruthy()
	expect(busyOff).toBeTruthy()
})

test('open command creates a new session', async () => {
	const before = runtime.sessions.size
	await commands.append(makeCommand('open', src))
	for (let i = 0; i < 50; i++) {
		await new Promise(r => setTimeout(r, 50))
		if (runtime.sessions.size > before) break
	}
	expect(runtime.sessions.size).toBe(before + 1)
})

test('close command removes session and creates replacement', async () => {
	const sid = runtime.activeSessionId!
	await commands.append(makeCommand('close', src, undefined, sid))
	await new Promise(r => setTimeout(r, 500))
	expect(runtime.sessions.has(sid)).toBe(false)
	expect(runtime.sessions.size).toBe(1)
})

test('reset command is persisted', async () => {
	const sid = runtime.activeSessionId!
	await commands.append(makeCommand('reset', src, undefined, sid))
	await new Promise(r => setTimeout(r, 500))
	const path = `${sessionDir(sid)}/messages.asonl`
	expect(existsSync(path)).toBe(true)
	const raw = await readFile(path, 'utf-8')
	const entries = parseAll(raw) as any[]
	expect(entries.some(e => e.type === 'reset')).toBe(true)
})

test('multiple prompts build conversation history', async () => {
	await sendAndWait('First message')
	await sendAndWait('Second message')
	const sid = runtime.activeSessionId!
	const raw = await readFile(`${sessionDir(sid)}/messages.asonl`, 'utf-8')
	const entries = parseAll(raw) as any[]
	const users = entries.filter(e => e.role === 'user')
	expect(users.length).toBe(2)
	expect(users[0].content).toBe('First message')
	expect(users[1].content).toBe('Second message')
})

test('sessions survive restart', async () => {
	await sendAndWait('Remember me')
	const sid = runtime.activeSessionId!
	// Wait for post-generation status flush (writes sessions to state)
	await new Promise(r => setTimeout(r, 200))

	// Stop runtime (simulates quit)
	runtime.stop()
	await releaseHost(hostId)

	// Re-claim and start fresh runtime (simulates relaunch)
	hostId = `${process.pid}-${randomBytes(4).toString('hex')}`
	await claimHost(hostId)
	runtime = await startRuntime()

	// Same session should be restored
	expect(runtime.activeSessionId).toBe(sid)
	expect(runtime.sessions.has(sid)).toBe(true)
})


test('multiple sessions survive restart in order', async () => {
	const first = runtime.activeSessionId!

	await commands.append(makeCommand('open', src))
	await commands.append(makeCommand('open', src))

	for (let i = 0; i < 100; i++) {
		await new Promise(r => setTimeout(r, 50))
		if (runtime.sessions.size >= 3) break
	}

	const beforeOrder = [...runtime.sessions.keys()]
	expect(beforeOrder.length).toBe(3)
	expect(beforeOrder[0]).toBe(first)

	await new Promise(r => setTimeout(r, 200))
	runtime.stop()
	await releaseHost(hostId)

	hostId = `${process.pid}-${randomBytes(4).toString('hex')}`
	await claimHost(hostId)
	runtime = await startRuntime()

	const afterOrder = [...runtime.sessions.keys()]
	expect(afterOrder).toEqual(beforeOrder)
	expect(runtime.activeSessionId).toBe(beforeOrder[beforeOrder.length - 1])
})


test('restart detects interrupted user turn but waits for /continue', async () => {
	runtime.stop()
	await releaseHost(hostId)

	const info = await createSession()
	const sid = info.id
	const ts = new Date().toISOString()
	await appendMessages(sid, [{ role: 'user', content: 'Please continue this after restart', ts } as any])
	updateState((s) => {
		s.sessions = [sid]
		s.activeSessionId = sid
		s.busySessionIds = [sid]
	})

	hostId = `${process.pid}-${randomBytes(4).toString('hex')}`
	await claimHost(hostId)
	runtime = await startRuntime()

	let sawNotice = false
	let sawDoneBeforeContinue = false
	for (let i = 0; i < 60; i++) {
		await new Promise(r => setTimeout(r, 50))
		const all = await events.readAll()
		sawNotice = all.some((e) => e.type === 'line' && e.sessionId === sid && e.text.includes('Type /continue to continue'))
		sawDoneBeforeContinue = all.some((e) => e.type === 'command' && e.sessionId === sid && e.phase === 'done')
		if (sawNotice) break
	}
	expect(sawNotice).toBe(true)
	expect(sawDoneBeforeContinue).toBe(false)

	const resumed = await sendAndWait('/continue', sid)
	const doneAfter = resumed.some((e) => e.type === 'command' && e.sessionId === sid && e.phase === 'done')
	expect(doneAfter).toBe(true)
})

test('interrupted tool round requires skip before /continue', async () => {
	runtime.stop()
	await releaseHost(hostId)

	const info = await createSession()
	const sid = info.id
	const ts = new Date().toISOString()
	await appendMessages(sid, [{ role: 'user', content: 'Trigger tools', ts } as any])
	const { entry } = await writeAssistantEntry(sid, {
		text: 'Running tools',
		toolCalls: [
			{ id: 't1', name: 'write', input: { path: '/tmp/a', content: 'x' } },
			{ id: 't2', name: 'read', input: { path: 'package.json' } },
		],
	})
	await appendMessages(sid, [entry])
	updateState((s) => {
		s.sessions = [sid]
		s.activeSessionId = sid
		s.busySessionIds = [sid]
	})

	hostId = `${process.pid}-${randomBytes(4).toString('hex')}`
	await claimHost(hostId)
	runtime = await startRuntime()

	await commands.append(makeCommand('continue', src, undefined, sid))
	await new Promise(r => setTimeout(r, 200))
	let all = await events.readAll()
	expect(all.some((e) => e.type === 'line' && e.sessionId === sid && e.text.includes('Use /respond skip, then /continue'))).toBe(true)

	await commands.append(makeCommand('respond', src, 'skip', sid))
	await new Promise(r => setTimeout(r, 200))

	const raw = await readFile(`${sessionDir(sid)}/messages.asonl`, 'utf-8')
	const entries = parseAll(raw) as any[]
	const toolResults = entries.filter((e) => e.role === 'tool_result')
	expect(toolResults.length).toBe(2)

	all = await events.readAll()
	expect(all.some((e) => e.type === 'line' && e.sessionId === sid && e.text.includes('marked skipped'))).toBe(true)
})

test('prompt auto-resolves interrupted tools instead of 400 error', async () => {
	runtime.stop()
	await releaseHost(hostId)

	const info = await createSession()
	const sid = info.id
	const ts = new Date().toISOString()
	await appendMessages(sid, [{ role: 'user', content: 'Trigger tools', ts } as any])
	const { entry } = await writeAssistantEntry(sid, {
		text: 'Running tools',
		toolCalls: [
			{ id: 't1', name: 'write', input: { path: '/tmp/a', content: 'x' } },
			{ id: 't2', name: 'read', input: { path: 'package.json' } },
		],
	})
	await appendMessages(sid, [entry])
	updateState((s) => {
		s.sessions = [sid]
		s.activeSessionId = sid
		s.busySessionIds = [sid]
	})

	hostId = `${process.pid}-${randomBytes(4).toString('hex')}`
	await claimHost(hostId)
	runtime = await startRuntime()
	await new Promise(r => setTimeout(r, 300))

	// Send a new prompt — should auto-resolve interrupted tools and succeed
	await commands.append(makeCommand('prompt', src, 'hello after interrupt', sid))
	await new Promise(r => setTimeout(r, 500))

	const raw = await readFile(`${sessionDir(sid)}/messages.asonl`, 'utf-8')
	const entries = parseAll(raw) as any[]
	const toolResults = entries.filter((e: any) => e.role === 'tool_result')
	expect(toolResults.length).toBe(2)
	expect(toolResults[0].tool_use_id).toBe('t1')
	expect(toolResults[1].tool_use_id).toBe('t2')

	// Should have generated a response (done event, no 400 error)
	const all = await events.readAll()
	const errors = all.filter((e: any) => e.type === 'line' && e.level === 'error' && e.sessionId === sid)
	expect(errors.length).toBe(0)
	const done = all.some((e: any) => e.type === 'command' && e.sessionId === sid && e.phase === 'done')
	expect(done).toBe(true)
})

test('pause command stops an active generation', async () => {
	const sid = runtime.activeSessionId!
	const snapshot = (await events.readAll()).length

	// Start a slow generation (spam = streaming wall of text)
	await commands.append(makeCommand('prompt', src, 'spam', sid))

	// Wait until we see at least one chunk (generation started)
	for (let i = 0; i < 100; i++) {
		await new Promise(r => setTimeout(r, 30))
		const all = await events.readAll()
		const recent = all.slice(snapshot)
		if (recent.some(e => e.type === 'chunk')) break
	}

	// Send pause
	await commands.append(makeCommand('pause', src, undefined, sid))

	// Wait for generation to end
	for (let i = 0; i < 100; i++) {
		await new Promise(r => setTimeout(r, 50))
		const all = await events.readAll()
		const recent = all.slice(snapshot)
		const done = recent.find(e => e.type === 'command' && (e.phase === 'done' || e.phase === 'failed'))
		if (done) break
	}

	const all = await events.readAll()
	const recent = all.slice(snapshot)

	// Should see [paused] meta line
	const paused = recent.find(e => e.type === 'line' && e.text === '[paused]')
	expect(paused).toBeTruthy()

	// Session should no longer be busy
	expect(runtime.busySessionIds.has(sid)).toBe(false)
})

test('ask tool sends question event and waits for respond', { timeout: 10000 }, async () => {
	const sid = runtime.activeSessionId!
	const snapshot = (await events.readAll()).length

	await commands.append(makeCommand('prompt', src, 'ask Do you prefer tabs or spaces?', sid))

	let questionEvent: any = null
	for (let i = 0; i < 100; i++) {
		await new Promise(r => setTimeout(r, 50))
		const all = await events.readAll()
		const recent = all.slice(snapshot)
		questionEvent = recent.find(e => e.type === 'question')
		if (questionEvent) break
	}
	expect(questionEvent).toBeTruthy()
	expect(questionEvent.text).toBe('Do you prefer tabs or spaces?')
	expect(runtime.busySessionIds.has(sid)).toBe(true)

	await commands.append(makeCommand('respond', src, 'tabs obviously', sid))

	for (let i = 0; i < 200; i++) {
		await new Promise(r => setTimeout(r, 50))
		const all = await events.readAll()
		const recent = all.slice(snapshot)
		if (recent.some(e => e.type === 'command' && (e.phase === 'done' || e.phase === 'failed'))) break
	}

	expect(runtime.busySessionIds.has(sid)).toBe(false)
})