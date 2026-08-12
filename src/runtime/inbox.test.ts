import { afterEach, expect, test } from 'bun:test'
import { inbox } from './inbox.ts'

const origPollInterval = inbox.config.pollIntervalMs

afterEach(() => {
	inbox.config.pollIntervalMs = origPollInterval
})

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (check()) return
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

// Regression: on macOS a brand-new session inbox directory is reported by the
// recursive watcher as a bare directory name with no "<dir>/<file>" event for
// the message written into it, so the first message to a freshly spawned
// session used to sit in the inbox forever. Delivery must not depend on the
// shape (or arrival) of fs.watch events, so poll fast here: the test then
// passes on the poll alone even when no usable watch event shows up.
test('message to a session directory that did not exist yet is delivered', async () => {
	inbox.config.pollIntervalMs = 20
	const controller = new AbortController()
	const seen: Array<[string, string]> = []
	inbox.startWatching(controller.signal, (sessionId, text) => seen.push([sessionId, text]))

	const sessionId = `fresh-${Date.now()}`
	inbox.queueMessage(sessionId, 'hello there')

	await waitFor(() => seen.length > 0)
	controller.abort()
	expect(seen).toEqual([[sessionId, 'hello there']])
}, 15_000)
