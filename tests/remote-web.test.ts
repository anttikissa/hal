import { expect, test } from 'bun:test'
import { webConnection } from '../src/client/web-connection.ts'
import { ensureStateDir } from '../src/server/state.ts'
import { web } from '../src/server/web.ts'
import { serverKeys } from '../src/server/server-keys.ts'

test('remote client reports the server authentication error', async () => {
	const controller = new AbortController()
	ensureStateDir()
	web.start(0, controller.signal)
	try {
		await expect(webConnection.connect(`http://127.0.0.1:${web.state.port}/?auth=wrong-token`, controller.signal)).rejects.toThrow(
			'Invalid authentication token',
		)
	} finally {
		controller.abort()
	}
})

test('remote client reconnects after the host restarts', async () => {
	ensureStateDir()
	const first = new AbortController()
	web.start(0, first.signal)
	const port = web.state.port
	const url = `http://127.0.0.1:${port}/?auth=${serverKeys.ensureLocalToken().token}`
	const clientAbort = new AbortController()
	try {
		await webConnection.connect(url, clientAbort.signal)
		expect(webConnection.state.socket?.readyState).toBe(WebSocket.OPEN)

		first.abort()
		await Bun.sleep(50)
		expect(webConnection.state.socket?.readyState).not.toBe(WebSocket.OPEN)

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
	}
})
