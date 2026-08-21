import { expect, test } from 'bun:test'
import { webConnection } from '../src/client/web-connection.ts'
import { ensureStateDir } from '../src/server/state.ts'
import { web } from '../src/server/web.ts'

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
