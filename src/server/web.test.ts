import { expect, test } from 'bun:test'
import type { SharedState } from '../common/ipc.ts'
import { ipc } from './file-ipc.ts'
import { blob } from './session/blob.ts'
import { sessions } from './sessions.ts'
import { web } from './web.ts'
import { runtime } from './runtime.ts'

test('web fallback port advances by a randomized exponential step', () => {
	expect(web.nextPort(9001, 1, () => 0)).toBe(9002)
	expect(web.nextPort(9001, 1, () => 0.99)).toBe(9003)
	expect(web.nextPort(9003, 2, () => 0)).toBe(9004)
})

test('web announcement is opt-in and names the actual loopback URL', () => {
	const originalEmitInfo = runtime.emitInfo
	const calls: Array<[string, string]> = []
	runtime.emitInfo = (sessionId: string, text: string) => { calls.push([sessionId, text]) }
	try {
		web.announce('', 9001)
		web.announce('04-fresh', 9002)
		expect(calls).toEqual([['04-fresh', 'Web interface available at http://127.0.0.1:9002/']])
	} finally {
		runtime.emitInfo = originalEmitInfo
	}
})

test('web page serves the web client HTML', async () => {
	const page = await web.pageHtml()
	const source = await Bun.file(`${import.meta.dir}/../web-client/index.html`).text()
	expect(page).toBe(source)
})

test('web bundle compiles the Solid TSX entry', async () => {
	expect((await web.bundleClient()).length).toBeGreaterThan(1_000)
})

test('session snapshot exposes typed history and live blocks without lossy mapping', () => {
	const originalReadState = ipc.readState
	const originalLoadAllHistory = sessions.loadAllHistory
	const originalLoadLive = sessions.loadLive
	const state: SharedState = {
		sessions: [{ id: '04-work', tab: 1, name: 'work', cwd: '/work', model: 'openai/gpt-5.6-sol' }],
		working: { '04-work': true },
		updatedAt: '2026-08-13T12:00:00.000Z',
	}
	ipc.readState = () => state
	sessions.loadAllHistory = () => [{ type: 'user', parts: [{ type: 'text', text: 'hello' }], ts: '2026-08-13T11:59:00.000Z' }]
	sessions.loadLive = () => ({ blocks: [{ type: 'tool', name: 'read', toolId: 'tool-1', input: { path: 'README.md' }, running: true }] })
	try {
		expect(web.sessionSnapshot('04-work')).toEqual({
			session: state.sessions[0]!,
			history: [{ type: 'user', parts: [{ type: 'text', text: 'hello' }], ts: '2026-08-13T11:59:00.000Z' }],
			live: [{ type: 'tool', name: 'read', toolId: 'tool-1', input: { path: 'README.md' }, running: true }],
		})
		expect(web.sessionSnapshot('missing')).toBeNull()
	} finally {
		ipc.readState = originalReadState
		sessions.loadAllHistory = originalLoadAllHistory
		sessions.loadLive = originalLoadLive
	}
})

test('session snapshot hydrates persisted tool output for browser presentation', () => {
	const originalReadState = ipc.readState
	const originalLoadAllHistory = sessions.loadAllHistory
	const originalLoadLive = sessions.loadLive
	const originalReadBlobFromChain = blob.readBlobFromChain
	ipc.readState = () => ({
		sessions: [{ id: '04-work', cwd: '/work' }],
		working: {},
		updatedAt: '2026-08-13T12:00:00.000Z',
	})
	sessions.loadAllHistory = () => [{ type: 'tool_result', toolId: 'tool-1', blobId: 'blob-1' }]
	sessions.loadLive = () => ({ blocks: [] })
	blob.readBlobFromChain = () => ({ result: { content: 'line 1\nline 2' } })
	try {
		expect(web.sessionSnapshot('04-work')?.history).toEqual([{
			type: 'tool_result',
			toolId: 'tool-1',
			blobId: 'blob-1',
			output: 'line 1\nline 2',
		}])
	} finally {
		ipc.readState = originalReadState
		sessions.loadAllHistory = originalLoadAllHistory
		sessions.loadLive = originalLoadLive
		blob.readBlobFromChain = originalReadBlobFromChain
	}
})

test('websocket live messages preserve complete typed events', () => {
	const event = {
		type: 'tool-result' as const,
		sessionId: '04-work',
		toolId: 'tool-1',
		output: 'done',
		blobId: 'blob-1',
		phase: 'done' as const,
		createdAt: '2026-08-13T12:00:01.000Z',
	}
	expect(web.liveEventMessage(event)).toEqual({ type: 'event', event })
	expect(web.liveEventMessage({ type: 'history-rebased', sessionId: '04-work' })).toBeNull()
	expect(web.liveEventMessage({ type: 'prompt', sessionId: '04-work', text: 'hello' })).toEqual({
		type: 'event',
		event: { type: 'prompt', sessionId: '04-work', text: 'hello' },
	})
})

test('websocket snapshots refresh only at persisted-history boundaries', () => {
	expect(web.isSnapshotBoundary({ type: 'prompt', sessionId: '04-work' })).toBe(false)
	expect(web.isSnapshotBoundary({ type: 'stream-end', sessionId: '04-work' })).toBe(true)
	expect(web.isSnapshotBoundary({ type: 'history-rebased', sessionId: '04-work' })).toBe(true)
	expect(web.isSnapshotBoundary({ type: 'stream-delta', sessionId: '04-work' })).toBe(false)
})

test('websocket subscription parser accepts only a valid open-session request', () => {
	expect(web.parseClientMessage(JSON.stringify({ type: 'subscribe', sessionId: '04-work' }))).toEqual({ type: 'subscribe', sessionId: '04-work' })
	expect(web.parseClientMessage(JSON.stringify({ type: 'subscribe', sessionId: '' }))).toBeNull()
	expect(web.parseClientMessage(JSON.stringify({ type: 'other', sessionId: '04-work' }))).toBeNull()
	expect(web.parseClientMessage('not json')).toBeNull()
})
