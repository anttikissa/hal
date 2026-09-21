import { expect, test } from 'bun:test'
import { webConnection } from '../src/client/web-connection.ts'
import { ensureStateDir } from '../src/server/state.ts'
import { web } from '../src/server/web.ts'
import { serverKeys } from '../src/server/server-keys.ts'

const originalNormalizeHost = webConnection.normalizeHost
const originalSocketUrl = webConnection.socketUrl

function useLocalWebSocket(): () => void {
	webConnection.normalizeHost = (host) => host
	webConnection.socketUrl = (host) => `ws://${host}/ws`
	return () => {
		webConnection.normalizeHost = originalNormalizeHost
		webConnection.socketUrl = originalSocketUrl
	}
}

test('remote client reports the server authentication error', async () => {
	const controller = new AbortController()
	const restore = useLocalWebSocket()
	ensureStateDir()
	web.start(0, controller.signal)
	try {
		await expect(webConnection.connect(`127.0.0.1:${web.state.port}`, 'wrong-token', controller.signal)).rejects.toThrow(
			'Invalid authentication token',
		)
	} finally {
		controller.abort()
		webConnection.reset()
		restore()
	}
})

test('remote client reconnects after the host restarts', async () => {
	ensureStateDir()
	const restore = useLocalWebSocket()
	const first = new AbortController()
	web.start(0, first.signal)
	const port = web.state.port
	const host = `127.0.0.1:${port}`
	const token = serverKeys.ensureLocalToken().token
	const clientAbort = new AbortController()
	try {
		await webConnection.connect(host, token, clientAbort.signal)
		expect(webConnection.state.socket?.readyState).toBe(WebSocket.OPEN)

		first.abort()
		await Bun.sleep(50)
		expect(webConnection.state.socket?.readyState).not.toBe(WebSocket.OPEN)
		expect(webConnection.state.reconnecting).toBe(true)
		expect(() => webConnection.sendCommand({ type: 'focus', sessionId: 'missing' })).not.toThrow()

		const second = new AbortController()
		web.start(port, second.signal)
		try {
			const deadline = Date.now() + 5_000
			while (Date.now() < deadline && webConnection.state.socket?.readyState !== WebSocket.OPEN) await Bun.sleep(25)
			expect(webConnection.state.socket?.readyState).toBe(WebSocket.OPEN)
			expect(webConnection.state.shared.updatedAt).not.toBe('')
		} finally {
			second.abort()
		}
	} finally {
		clientAbort.abort()
		webConnection.reset()
		restore()
	}
})
