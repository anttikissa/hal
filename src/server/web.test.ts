import { expect, test } from 'bun:test'
import type { SharedState } from '../common/ipc.ts'
import { webProtocol, type WebServerMessage } from '../common/web.ts'
import { ipc } from './file-ipc.ts'
import { blob } from './session/blob.ts'
import { runtime } from './runtime.ts'
import { sessions } from './sessions.ts'
import { ensureStateDir } from './state.ts'
import { web } from './web.ts'
import { webUpload } from './web-upload.ts'
import { serverKeys } from './server-keys.ts'
import { processControl } from './process-control.ts'
import { ason } from '../utils/ason.ts'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

test('web fallback port advances by a randomized exponential step', () => {
	expect(web.nextPort(9001, 1, () => 0)).toBe(9002)
	expect(web.nextPort(9001, 1, () => 0.99)).toBe(9003)
	expect(web.nextPort(9003, 2, () => 0)).toBe(9004)
})
test('web origin uses the actual local port or configured public hostname', () => {
	const original = webUpload.config.hostname
	try {
		webUpload.config.hostname = ''
		expect(web.origin(9002)).toBe('http://localhost:9002')
		webUpload.config.hostname = 'hal.antti.dev'
		expect(web.origin(9002)).toBe('https://hal.antti.dev')
		expect(web.urlForToken({ token: 'secret', purpose: 'test', createdAt: '' }, 9002)).toBe('https://hal.antti.dev/?auth=secret')
		webUpload.config.hostname = 'evil.test/steal'
		expect(() => web.origin(9002)).toThrow('Invalid web hostname')
	} finally {
		webUpload.config.hostname = original
	}
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

test('web declares a standalone home-screen app with install icons', async () => {
	const html = await web.pageHtml()
	expect(html).toContain('name="mobile-web-app-capable" content="yes"')
	expect(html).toContain('name="apple-mobile-web-app-title" content="HAL"')
	expect(html).toContain('rel="manifest" href="/manifest.webmanifest"')
	expect(html).toContain('rel="apple-touch-icon" href="/icons/icon-180.png"')

	const manifestResponse = web.appAsset('/manifest.webmanifest')
	expect(manifestResponse?.headers.get('content-type')).toBe('application/manifest+json; charset=utf-8')
	expect(await manifestResponse?.json()).toEqual({
		name: 'HAL',
		short_name: 'HAL',
		start_url: '/',
		scope: '/',
		display: 'standalone',
		background_color: '#111111',
		theme_color: '#111111',
		icons: [
			{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
			{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
		],
	})

	for (const path of ['/icon.svg', '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png']) {
		const response = web.appAsset(path)
		expect(response?.status).toBe(200)
		expect((await response?.arrayBuffer())?.byteLength).toBeGreaterThan(0)
	}
})

test('the public CSS asset resolves the current shared palette without authentication', async () => {
	const response = web.appAsset('/colors.css')
	expect(response?.headers.get('content-type')).toBe('text/css; charset=utf-8')
	expect(response?.headers.get('cache-control')).toBe('no-store')
	expect(response?.headers.get('x-content-type-options')).toBe('nosniff')
	expect(await response?.text()).toContain('--assistant-fg: oklch(')
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
test('image endpoint serves stored blobs only with web authentication', async () => {
	const originalRead = blob.readBlobFromChain
	const originalAuth = serverKeys.authenticate
	blob.readBlobFromChain = () => ({ media_type: 'image/png', data: 'aGVsbG8=' })
	serverKeys.authenticate = (token) => token === 'valid' ? { token, purpose: 'test', createdAt: '' } : null
	try {
		const path = 'http://localhost:9001/images/05-wan/000123-abc'
		const denied = await web.imageResponse(new Request(path), '127.0.0.1')
		expect(denied.status).toBe(401)
		const allowed = await web.imageResponse(new Request(`${path}?auth=valid`), '127.0.0.1')
		expect(allowed.status).toBe(200)
		expect(allowed.headers.get('content-type')).toBe('image/png')
		expect(await allowed.text()).toBe('hello')
		expect((await web.imageResponse(new Request('http://localhost:9001/images/05-wan/../secret?auth=valid'), '127.0.0.1')).status).toBe(404)
		blob.readBlobFromChain = () => ({ media_type: 'text/html', data: 'aGVsbG8=' })
		expect((await web.imageResponse(new Request(`${path}?auth=valid`), '127.0.0.1')).status).toBe(404)
	} finally {
		blob.readBlobFromChain = originalRead
		serverKeys.authenticate = originalAuth
	}
})

test('websocket parser accepts ASON authentication and ordinary commands', () => {
	expect(web.parseClientMessage("{ type: 'authenticate', token: 'aBcDeFgHiJkL' }")).toEqual({ type: 'authenticate', token: 'aBcDeFgHiJkL' })
	expect(web.parseClientMessage("{ type: 'authenticate', token: 'aBcDeFgHiJkL', focus: '04-work' }")).toEqual({ type: 'authenticate', token: 'aBcDeFgHiJkL', focus: '04-work' })
	expect(web.parseClientMessage("{ type: 'command', command: { type: 'abort', sessionId: '04-work' } }")).toEqual({ type: 'command', command: { type: 'abort', sessionId: '04-work' } })
	expect(web.parseClientMessage("{ type: 'command', command: { type: 'prompt', text: 42 } }")).toBeNull()
	expect(web.parseClientMessage("{ type: 'command', command: { type: 'prompt', id: 'bad', text: 'hello' } }")).toBeNull()
	expect(web.parseClientMessage("{ type: 'command', command: { type: 'prompt', id: '000001-abc', text: 'hello' } }")).not.toBeNull()
	expect(web.parseCommand({ type: 'answer', sessionId: '04-work', questionId: 'q1', value: { kind: 'choice', choiceId: 'yes' } })).toMatchObject({ type: 'answer', questionId: 'q1' })
	expect(web.parseCommand({ type: 'answer', sessionId: '04-work', questionId: 'q1', value: { kind: 'secret', ciphertext: 'x'.repeat(5587) } })).toBeNull()
})

test('websocket is an authenticated ASON command bus', async () => {
	const controller = new AbortController()
	const originalHandle = runtime.handleCommand
	let received: any
	ensureStateDir()
	web.start(0, controller.signal)
	try {
		const token = serverKeys.list()[0]!
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

test('websocket snapshots refresh history boundaries', () => {
	expect(web.isSnapshotBoundary({ type: 'stream-end' })).toBe(true)
	expect(web.isSnapshotBoundary({ type: 'history-replaced' })).toBe(true)
	expect(web.isSnapshotBoundary({ type: 'history-updated' })).toBe(true)
	expect(web.isSnapshotBoundary({ type: 'stream-delta' })).toBe(false)
})

test('completions/cd lists host directories for authenticated remote clients', async () => {
	const controller = new AbortController()
	ensureStateDir()
	web.start(0, controller.signal)
	const root = mkdtempSync(join(tmpdir(), 'hal-dirs-'))
	try {
		mkdirSync(join(root, 'alpha'))
		mkdirSync(join(root, 'beta'))
		const url = `http://127.0.0.1:${web.state.port}/completions/cd?cwd=${encodeURIComponent(root)}&prefix=a`
		expect((await fetch(url)).status).toBe(401)
		const response = await fetch(url, { headers: { authorization: `Bearer ${serverKeys.list()[0]!.token}` } })
		expect(ason.parse(await response.text())).toEqual(['alpha/'])
	} finally {
		rmSync(root, { recursive: true, force: true })
		controller.abort()
	}
})

test('update endpoint is inert without a token and rejects wrong credentials', async () => {
	const originalToken = process.env.UPDATE_TOKEN
	delete process.env.UPDATE_TOKEN
	try {
		expect((await web.handleUpdateRequest(new Request('https://hal.local/api/update', { method: 'POST' }))).status).toBe(401)
		process.env.UPDATE_TOKEN = 'secret-token'
		expect((await web.handleUpdateRequest(new Request('https://hal.local/api/update', { method: 'GET' }))).status).toBe(404)
		expect((await web.handleUpdateRequest(new Request('https://hal.local/api/update', { method: 'POST' }))).status).toBe(401)
		expect((await web.handleUpdateRequest(new Request('https://hal.local/api/update', { method: 'POST', headers: { authorization: 'Bearer wrong' } }))).status).toBe(401)
	} finally {
		if (originalToken === undefined) delete process.env.UPDATE_TOKEN
		else process.env.UPDATE_TOKEN = originalToken
	}
})
// Stub the git helpers so endpoint tests never touch a real repository.
function stubUpdateGit(fetchExit: number, head: string | null, upstream: string | null): void {
	web.runGit = async () => fetchExit
	web.gitOut = async (args) => (args.includes('HEAD') ? head : upstream)
}

test('update endpoint with the right token answers, then exits the process', async () => {
	const originalToken = process.env.UPDATE_TOKEN
	const originalExit = processControl.io.exit
	const originalRunGit = web.runGit
	const originalGitOut = web.gitOut
	process.env.UPDATE_TOKEN = 'secret-token'
	let exitCode: number | undefined
	processControl.io.exit = (code) => {
		exitCode = code
	}
	try {
		// Up to date (edited and pushed on the server): answer but do not restart.
		stubUpdateGit(0, 'aaaa', 'aaaa')
		let response = await web.handleUpdateRequest(new Request('https://hal.local/api/update', { method: 'POST', headers: { authorization: 'Bearer secret-token' } }))
		expect(await response.text()).toBe('Already up to date\n')
		expect(exitCode).toBeUndefined()

		// Fetch failure: keep serving rather than restart into an unknown state.
		stubUpdateGit(128, 'aaaa', null)
		response = await web.handleUpdateRequest(new Request('https://hal.local/api/update', { method: 'POST', headers: { authorization: 'Bearer secret-token' } }))
		expect(response.status).toBe(500)
		expect(exitCode).toBeUndefined()

		// New commits on origin: return the response before exiting on the next turn.
		stubUpdateGit(0, 'aaaa', 'bbbb')
		response = await web.handleUpdateRequest(new Request('https://hal.local/api/update', { method: 'POST', headers: { authorization: 'Bearer secret-token' } }))
		expect(await response.text()).toBe('Updating\n')
		expect(exitCode).toBeUndefined()
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(exitCode).toBe(42)
	} finally {
		processControl.io.exit = originalExit
		processControl.state.exitCode = null
		web.runGit = originalRunGit
		web.gitOut = originalGitOut
		if (originalToken === undefined) delete process.env.UPDATE_TOKEN
		else process.env.UPDATE_TOKEN = originalToken
	}
})

test('session urls serve the browser app so a tab is shareable as a link', async () => {
	const controller = new AbortController()
	ensureStateDir()
	web.start(0, controller.signal)
	try {
		const base = `http://127.0.0.1:${web.state.port}`
		const page = await Bun.file(`${import.meta.dir}/../web-client/index.html`).text()
		const session = await fetch(`${base}/05-wan`)
		expect(session.status).toBe(200)
		expect(await session.text()).toBe(page)
		// Unknown paths must still 404 rather than rendering the app.
		expect((await fetch(`${base}/nope`)).status).toBe(404)
		expect((await fetch(`${base}/05-wan/extra`)).status).toBe(404)
		// Real endpoints keep their own handling.
		expect((await fetch(`${base}/styles.css`)).headers.get('content-type')).toContain('text/css')
	} finally {
		controller.abort()
	}
})

test('bootstrap carries only the focused snapshot; the rest stream nearest-first', () => {
	const originalReadState = ipc.readState
	const originalSnapshot = web.sessionSnapshot
	const ids = ['01-a', '02-b', '03-c', '04-d', '05-e']
	ipc.readState = () => ({ sessions: ids.map((id) => ({ id, cwd: '/' })), working: {}, updatedAt: '' })
	web.sessionSnapshot = (id: string) => ({ session: { id, cwd: '/' }, meta: { id, createdAt: '' }, history: [], parentCount: 0, live: [] })
	try {
		expect(web.bootstrap('04-d').snapshots.map((s) => s.session.id)).toEqual(['04-d'])
		expect(web.streamOrder('04-d')).toEqual(['03-c', '05-e', '02-b', '01-a'])
		// Browsers send no focus; the first tab stands in for it.
		expect(web.bootstrap().snapshots.map((s) => s.session.id)).toEqual(['01-a'])
		expect(web.streamOrder()).toEqual(['02-b', '03-c', '04-d', '05-e'])
	} finally {
		ipc.readState = originalReadState
		web.sessionSnapshot = originalSnapshot
	}
})
