import { afterEach, expect, test } from 'bun:test'
import { inbox } from './inbox.ts'
import { ipc } from '../file-ipc.ts'

const origPollInterval = inbox.config.pollIntervalMs
const origReadState = ipc.readState

afterEach(() => {
	inbox.config.pollIntervalMs = origPollInterval
	ipc.readState = origReadState
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
	ipc.readState = () => ({
		sessions: [{ id: seenId, tab: 1, cwd: '/tmp' }],
		working: {},
		updatedAt: new Date().toISOString(),
	})
	const controller = new AbortController()
	const seen: Array<[string, string]> = []
	let seenId = ''
	inbox.startWatching(controller.signal, (sessionId, text) => seen.push([sessionId, text]))

	const sessionId = `fresh-${Date.now()}`
	seenId = sessionId
	inbox.queueMessage(sessionId, 'hello there')

	await waitFor(() => seen.length > 0)
	controller.abort()
	expect(seen).toEqual([[sessionId, 'hello there']])
}, 15_000)


test('message delivery preserves the sender tab', async () => {
	inbox.config.pollIntervalMs = 20
	const controller = new AbortController()
	const sessionId = `sender-tab-${Date.now()}`
	ipc.readState = () => ({
		sessions: [{ id: 'sender', tab: 6, cwd: '/tmp' }, { id: sessionId, tab: 7, cwd: '/tmp' }],
		working: {},
		updatedAt: new Date().toISOString(),
	})
	const seen: Array<{ source?: string; sourceTab?: number }> = []
	inbox.startWatching(controller.signal, (receivedId, _text, source, _queue, sourceTab) => {
		if (receivedId === sessionId) seen.push({ source, sourceTab })
	})

	inbox.queueMessage(sessionId, 'hello there', 'sender')
	await waitFor(() => seen.length > 0)
	controller.abort()

	expect(seen).toEqual([{ source: 'sender', sourceTab: 6 }])
})


// Regression: a message to a session whose tab is closed (or not yet open in
// this host's shared state) must stay in its inbox file. The watcher callback
// filters by open sessions; deleting the file before that check silently
// destroyed handoffs to closed tabs (e.g. a subagent reporting to a parent
// that had just been auto-closed).
test('message to a closed session stays queued instead of being dropped', async () => {
	inbox.config.pollIntervalMs = 20
	ipc.readState = () => ({
		sessions: [{ id: 'other-session', tab: 1, cwd: '/tmp' }],
		working: {},
		updatedAt: new Date().toISOString(),
	})
	const controller = new AbortController()
	const seen: Array<[string, string]> = []
	inbox.startWatching(controller.signal, (sessionId, text) => seen.push([sessionId, text]))

	const sessionId = `closed-tab-${Date.now()}`
	inbox.queueMessage(sessionId, 'handoff for later')

	await new Promise((resolve) => setTimeout(resolve, 200))
	controller.abort()

	// Not delivered while the session is not open...
	expect(seen).toEqual([])
	// ...and still on disk for delivery when it is restored.
	const { readdirSync } = await import('fs')
	const files = readdirSync(`${inbox.inboxDir()}/${sessionId}`)
	expect(files.length).toBe(1)
})
