import { expect, test } from 'bun:test'
import type { SharedState } from '../common/ipc.ts'
import { webProtocol, type WebServerMessage } from '../common/web.ts'
import { ipc } from './file-ipc.ts'
import { blob } from './session/blob.ts'
import { runtime } from './runtime.ts'
import { sessions } from './sessions.ts'
import { ensureStateDir } from './state.ts'
import { web } from './web.ts'
import { serverKeys } from './server-keys.ts'
import { processControl } from './process-control.ts'

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
	// colors.ason is served raw: the browser parses it and builds its own CSS,
	// so the terminal and the web client follow the very same palette file.
	expect(await web.appAsset('/colors.ason')?.text()).toBe(await Bun.file(`${import.meta.dir}/../../colors.ason`).text())
	expect(await web.appAsset('/styles.css')?.text()).toBe(await Bun.file(`${import.meta.dir}/../web-client/styles.css`).text())
	expect((await web.bundleClient()).length).toBeGreaterThan(1_000)
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
	expect(web.isSnapshotBoundary({ type: 'history-rebased' })).toBe(true)
	expect(web.isSnapshotBoundary({ type: 'history-updated' })).toBe(true)
	expect(web.isSnapshotBoundary({ type: 'stream-delta' })).toBe(false)
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
