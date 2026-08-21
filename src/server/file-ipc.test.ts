import { expect, test, afterEach } from 'bun:test'
import { statSync } from 'fs'
import { ipc } from './file-ipc.ts'
import { IPC_DIR } from './state.ts'

const originalMax = ipc.config.maxLogBytes

afterEach(() => {
	ipc.config.maxLogBytes = originalMax
})

test('event log truncates instead of growing without bound', () => {
	ipc.config.maxLogBytes = 2000
	const path = `${IPC_DIR}/events.asonl`
	for (let i = 0; i < 200; i++) ipc.appendEvent({ type: 'info', sessionId: 's', text: `event ${i} ${'x'.repeat(100)}` })

	// Rotation keeps the file near the cap rather than accumulating every event.
	expect(statSync(path).size).toBeLessThan(ipc.config.maxLogBytes * 2)
})
