// Integration test — runtime + IPC end-to-end.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync, existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { randomBytes } from 'crypto'
import { ensureStateDir, STATE_DIR, SESSIONS_DIR } from '../state.ts'
import { ensureBus, claimHost, releaseHost, commands, events } from '../ipc.ts'
import { startRuntime, type Runtime } from './runtime.ts'
import { makeCommand, type RuntimeEvent } from '../protocol.ts'
import { parseAll } from '../utils/ason.ts'
import { sessionDir } from '../state.ts'

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
