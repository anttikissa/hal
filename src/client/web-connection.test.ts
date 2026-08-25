import { expect, test } from 'bun:test'
import { webConnection } from './web-connection.ts'
import { clientBackend } from './backend.ts'
import { clientTransport } from './transport.ts'

test('remote connection accepts the URL copied from /web', () => {
	expect(webConnection.parseUrl('http://localhost:9001/?auth=aBcDeFgHiJkL')).toEqual({
		webSocketUrl: 'ws://localhost:9001/ws',
		baseUrl: 'http://localhost:9001',
		token: 'aBcDeFgHiJkL',
	})
})

test('remote connection requires HTTP and the copied authentication token', () => {
	expect(() => webConnection.parseUrl('localhost:9001')).toThrow('Remote URL must start with http:// or https://')
	expect(() => webConnection.parseUrl('http://localhost:9001')).toThrow('Remote URL must contain ?auth=<token>')
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
