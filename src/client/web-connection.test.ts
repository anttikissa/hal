import { expect, test } from 'bun:test'
import { webConnection } from './web-connection.ts'
import { clientBackend } from './backend.ts'
import { clientTransport } from './transport.ts'

test('remote connection derives HTTPS endpoints from the host', () => {
	expect(webConnection.socketUrl('hal.example')).toBe('wss://hal.example/ws')
	expect(webConnection.uploadUrl('hal.example')).toBe('https://hal.example/upload')
})

test('remote connection requires a bare hostname', () => {
	expect(() => webConnection.connect('https://hal.example', 'secret', new AbortController().signal)).toThrow('Remote host must be a hostname')
	expect(() => webConnection.connect('hal.example:9001', 'secret', new AbortController().signal)).toThrow('Remote host must be a hostname')
})

test('remote image uploads use the host and authentication token separately', async () => {
	const originalFetch = webConnection.fetch
	webConnection.state.remote = { host: 'hal.example', authToken: 'secret' }
	try {
		webConnection.fetch = async (url, init) => {
			expect(url).toBe('https://hal.example/upload')
			expect(init?.headers).toEqual({ Authorization: 'Bearer secret' })
			expect(init?.method).toBe('POST')
			const form = init?.body as FormData
			const file = form.get('file') as File
			expect(file.name).toBe('clipboard.png')
			expect(await file.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer)
			return new Response(JSON.stringify({ path: '/srv/hal/state/uploads/image.png' }))
		}
		expect(await webConnection.uploadImage(new Uint8Array([1, 2, 3]))).toBe('/srv/hal/state/uploads/image.png')
	} finally {
		webConnection.fetch = originalFetch
		webConnection.state.remote = null
	}
})

test('remote /cd completion asks the host for its directories', async () => {
	const originalFetch = webConnection.fetch
	webConnection.state.remote = { host: 'hal.example', authToken: 'secret' }
	try {
		webConnection.fetch = async (url, init) => {
			expect(url).toBe('https://hal.example/completions/cd?cwd=%2Fsrv&prefix=a')
			expect(init?.headers).toEqual({ Authorization: 'Bearer secret' })
			return new Response(`['alpha/']`)
		}
		expect(await webConnection.completeDirs('a', '/srv')).toEqual(['alpha/'])
	} finally {
		webConnection.fetch = originalFetch
		webConnection.state.remote = null
	}
})
test('remote reconnect delay starts at one second and grows by 60 percent', () => {
	let delay = 0
	const delays: number[] = []
	for (let i = 0; i < 10; i++) {
		delay = webConnection.nextRetryDelay(delay)
		delays.push(delay)
	}
	expect(delays).toEqual([1_000, 1_600, 2_560, 4_096, 6_554, 10_486, 16_778, 26_845, 30_000, 30_000])
})

test('reconnect tells the user when the connection drops and returns', async () => {
	const notices: string[] = []
	const originalNotify = webConnection.notify
	const originalOpen = webConnection.openSocket
	webConnection.notify = (text) => { notices.push(text) }
	let attempts = 0
	webConnection.openSocket = async () => {
		attempts++
		if (attempts === 1) throw new Error('still down')
	}
	try {
		await webConnection.reconnect({ host: 'hal.example', authToken: 'secret' }, new AbortController().signal)
		expect(notices).toEqual(['Lost connection to hal.example, reconnecting...', 'Reconnected to hal.example.'])
	} finally {
		webConnection.notify = originalNotify
		webConnection.openSocket = originalOpen
		webConnection.reset()
	}
})

test('remote bootstrap installs the same state and session ports as file IPC', () => {
	webConnection.applyBootstrap({
		state: { sessions: [{ id: '04-work', cwd: '/srv/work' }], working: {}, updatedAt: 'now' },
		metas: [{ id: '04-work', createdAt: 'then', workingDir: '/srv/work' }],
		snapshots: [{
			session: { id: '04-work', cwd: '/srv/work' },
			meta: { id: '04-work', createdAt: 'then', workingDir: '/srv/work' },
			history: [{ type: 'user', parts: [{ type: 'text', text: 'hello' }] }],
			parentCount: 0,
			live: [],
		}],
	})
	webConnection.install()

	expect(clientTransport.io.readState().sessions[0]?.id).toBe('04-work')
	expect(clientBackend.sessions.loadSessionMeta('04-work')?.workingDir).toBe('/srv/work')
	expect(clientBackend.sessions.loadAllHistoryWithOrigin('04-work').entries).toHaveLength(1)
})

test('remote history-updated observes the snapshot that arrived immediately before it', () => {
	webConnection.reset()
	webConnection.install()
	webConnection.applyMessage({
		type: 'snapshot',
		snapshot: {
			session: { id: '04-work', cwd: '/srv/work' },
			meta: { id: '04-work', createdAt: 'then', workingDir: '/srv/work' },
			history: [{ type: 'question', id: 'q1', text: 'Continue?', input: { kind: 'choice', choices: [{ id: 'yes', label: 'Yes' }] }, source: { type: 'intro' } }],
			parentCount: 0,
			live: [],
		},
	})
	webConnection.applyMessage({ type: 'event', event: { type: 'history-updated', sessionId: '04-work' } })
	expect(clientBackend.sessions.loadAllHistoryWithOrigin('04-work').entries[0]).toMatchObject({ type: 'question', id: 'q1' })
	expect(webConnection.state.events).toEqual([{ type: 'history-updated', sessionId: '04-work' }])
})

test('commands entered during reconnect do not throw', () => {
	webConnection.reset()
	webConnection.state.reconnecting = true

	expect(() => webConnection.sendCommand({ type: 'prompt', sessionId: '04-work', text: 'ignored' })).not.toThrow()

	webConnection.reset()
})
