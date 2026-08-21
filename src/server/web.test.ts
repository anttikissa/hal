import { expect, test } from 'bun:test'
import type { SharedState } from '../common/ipc.ts'
import { webProtocol, type WebServerMessage } from '../common/web.ts'
import { ipc } from './file-ipc.ts'
import { blob } from './session/blob.ts'
import { runtime } from './runtime.ts'
import { sessions } from './sessions.ts'
import { ensureStateDir } from './state.ts'
import { web } from './web.ts'
import { webTokens } from './web-tokens.ts'

test('web fallback port advances by a randomized exponential step', () => {
	expect(web.nextPort(9001, 1, () => 0)).toBe(9002)
	expect(web.nextPort(9001, 1, () => 0.99)).toBe(9003)
	expect(web.nextPort(9003, 2, () => 0)).toBe(9004)
})

test('web announcement is opt-in and includes an authenticated local URL', () => {
	const originalEmitInfo = runtime.emitInfo
	const calls: Array<[string, string]> = []
	runtime.emitInfo = (sessionId: string, text: string) => { calls.push([sessionId, text]) }
	try {
		web.announce('', 9001)
		web.announce('04-fresh', 9002)
		expect(calls).toHaveLength(1)
		expect(calls[0]?.[1]).toMatch(/^Web interface available at http:\/\/localhost:9002\/\?auth=[A-Za-z0-9]{12}$/)
	} finally {
		runtime.emitInfo = originalEmitInfo
	}
})

test('web serves and compiles the browser client', async () => {
	expect(await web.pageHtml()).toBe(await Bun.file(`${import.meta.dir}/../web-client/index.html`).text())
	expect(await web.styleCss()).toBe(await Bun.file(`${import.meta.dir}/../web-client/styles.css`).text())
	expect((await web.bundleClient()).length).toBeGreaterThan(1_000)
})

test('session snapshot exposes complete client bootstrap data', () => {
	const originalReadState = ipc.readState
	const originalLoadMeta = sessions.loadSessionMeta
	const originalLoadHistory = sessions.loadAllHistoryWithOrigin
	const originalLoadLive = sessions.loadLive
	const state: SharedState = {
		sessions: [{ id: '04-work', tab: 1, name: 'work', cwd: '/work', model: 'openai/gpt-5.6-sol' }],
		working: { '04-work': true },
		updatedAt: '2026-08-13T12:00:00.000Z',
	}
	ipc.readState = () => state
	sessions.loadSessionMeta = () => ({ id: '04-work', createdAt: '2026-08-13T11:00:00.000Z', workingDir: '/work' })
	sessions.loadAllHistoryWithOrigin = () => ({ entries: [{ type: 'user', parts: [{ type: 'text', text: 'hello' }] }], parentCount: 0 })
	sessions.loadLive = () => ({ blocks: [{ type: 'assistant', text: 'hi', streaming: true }] })
	try {
		expect(web.sessionSnapshot('04-work')).toEqual({
			session: state.sessions[0]!,
			meta: { id: '04-work', createdAt: '2026-08-13T11:00:00.000Z', workingDir: '/work' },
			history: [{ type: 'user', parts: [{ type: 'text', text: 'hello' }] }],
			parentCount: 0,
			parentId: undefined,
			live: [{ type: 'assistant', text: 'hi', streaming: true }],
		})
	} finally {
		ipc.readState = originalReadState
		sessions.loadSessionMeta = originalLoadMeta
		sessions.loadAllHistoryWithOrigin = originalLoadHistory
		sessions.loadLive = originalLoadLive
	}
})

test('session snapshot hydrates persisted tool output', () => {
	const originalReadState = ipc.readState
	const originalLoadMeta = sessions.loadSessionMeta
	const originalLoadHistory = sessions.loadAllHistoryWithOrigin
	const originalLoadLive = sessions.loadLive
	const originalReadBlob = blob.readBlobFromChain
	ipc.readState = () => ({ sessions: [{ id: '04-work', cwd: '/work' }], working: {}, updatedAt: '' })
	sessions.loadSessionMeta = () => ({ id: '04-work', createdAt: '' })
	sessions.loadAllHistoryWithOrigin = () => ({ entries: [{ type: 'tool_result', toolId: 'tool-1', blobId: 'blob-1' }], parentCount: 0 })
	sessions.loadLive = () => ({ blocks: [] })
	blob.readBlobFromChain = () => ({ result: { content: 'line 1\nline 2' } })
	try {
		expect(web.sessionSnapshot('04-work')?.history[0]).toMatchObject({ output: 'line 1\nline 2' })
	} finally {
		ipc.readState = originalReadState
		sessions.loadSessionMeta = originalLoadMeta
		sessions.loadAllHistoryWithOrigin = originalLoadHistory
		sessions.loadLive = originalLoadLive
		blob.readBlobFromChain = originalReadBlob
	}
})

test('websocket parser accepts ASON authentication and ordinary commands', () => {
	expect(web.parseClientMessage("{ type: 'authenticate', token: 'aBcDeFgHiJkL' }")).toEqual({ type: 'authenticate', token: 'aBcDeFgHiJkL' })
	expect(web.parseClientMessage("{ type: 'command', command: { type: 'abort', sessionId: '04-work' } }")).toEqual({ type: 'command', command: { type: 'abort', sessionId: '04-work' } })
	expect(web.parseClientMessage("{ type: 'command', command: { type: 'prompt', text: 42 } }")).toBeNull()
})

test('websocket is an authenticated ASON command bus', async () => {
	const controller = new AbortController()
	const originalHandle = runtime.handleCommand
	let received: any
	ensureStateDir()
	web.start(0, controller.signal)
	try {
		const token = webTokens.list()[0]!
		const socket = new WebSocket(`ws://127.0.0.1:${web.state.port}/ws`)
		await new Promise<void>((resolve, reject) => {
			socket.onerror = () => reject(new Error('socket failed'))
			socket.onopen = () => socket.send(webProtocol.encode({ type: 'authenticate', token: token.token }))
			socket.onmessage = (event) => {
				const message = webProtocol.decode(String(event.data)) as WebServerMessage
				if (message.type !== 'authenticated') return
				runtime.handleCommand = (command) => { received = command; resolve() }
				socket.send(webProtocol.encode({ type: 'command', command: { type: 'abort', sessionId: '04-work' } }))
			}
		})
		expect(received).toMatchObject({ type: 'abort', sessionId: '04-work' })
		const stateUpdate = new Promise<SharedState>((resolve) => {
			socket.onmessage = (event) => {
				const message = webProtocol.decode(String(event.data)) as WebServerMessage
				if (message.type === 'state' && message.state.summarizing?.['remote-test']) resolve(message.state)
			}
		})
		ipc.updateState((state) => { state.summarizing = { ...state.summarizing, 'remote-test': true } })
		expect((await stateUpdate).summarizing?.['remote-test']).toBe(true)
		ipc.updateState((state) => { delete state.summarizing?.['remote-test'] })
		socket.close()
	} finally {
		runtime.handleCommand = originalHandle
		controller.abort()
	}
})

test('websocket snapshots refresh at persisted-history boundaries', () => {
	expect(web.isSnapshotBoundary({ type: 'stream-end' })).toBe(true)
	expect(web.isSnapshotBoundary({ type: 'history-rebased' })).toBe(true)
	expect(web.isSnapshotBoundary({ type: 'stream-delta' })).toBe(false)
})
