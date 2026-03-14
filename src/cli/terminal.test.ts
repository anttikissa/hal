import { test, expect } from 'bun:test'
import { terminal } from './terminal.ts'

test('TERM_RESET contains kitty-off, bracketed-paste-off, and show-cursor', () => {
	expect(terminal.TERM_RESET).toContain('\x1b[<u')
	expect(terminal.TERM_RESET).toContain('\x1b[?2004l')
	expect(terminal.TERM_RESET).toContain('\x1b[?25h')
})

test('disableTerminalInput writes TERM_RESET to stdout', () => {
	let written = ''
	const mockStdout = { write(s: string) { written += s } }
	const mockStdin = makeMockStdin()

	terminal.disableTerminalInput(mockStdout, mockStdin)

	expect(written).toBe(terminal.TERM_RESET)
})

test('disableTerminalInput replaces data handler with noop', () => {
	const mockStdout = { write() {} }
	const mockStdin = makeMockStdin()

	let oldHandlerCalled = false
	mockStdin.on('data', () => { oldHandlerCalled = true })

	terminal.disableTerminalInput(mockStdout, mockStdin)

	// Old handler should have been removed
	for (const fn of mockStdin.handlers.get('data') ?? []) fn('garbage')
	expect(oldHandlerCalled).toBe(false)
})

test('disableTerminalInput keeps a data listener to drain buffered bytes', () => {
	const mockStdout = { write() {} }
	const mockStdin = makeMockStdin()

	terminal.disableTerminalInput(mockStdout, mockStdin)

	const handlers = mockStdin.handlers.get('data') ?? []
	expect(handlers.length).toBe(1)
	// Calling it should not throw
	expect(() => handlers[0]('\x1b[99;5:3u')).not.toThrow()
})

test('aborting sessions are excluded from handoff busy list', () => {
	// Sessions with an aborted signal (being paused) should not
	// appear in the handoff, otherwise they get auto-continued after restart.
	// Sessions with a non-aborted controller (active generation) should be kept.
	const busySessionIds = new Set(['session-a', 'session-b', 'session-c'])
	const abortedController = new AbortController()
	abortedController.abort()
	const activeController = new AbortController()
	const abortControllers = new Map<string, AbortController>([
		['session-b', abortedController],
		['session-c', activeController],
	])

	const filtered = [...busySessionIds].filter(id => {
		const ac = abortControllers.get(id)
		return !ac || !ac.signal.aborted
	})

	expect(filtered).toEqual(['session-a', 'session-c'])
	expect(filtered).not.toContain('session-b')
})

function makeMockStdin() {
	const handlers = new Map<string, Function[]>()
	return {
		handlers,
		removeAllListeners(event: string) { handlers.set(event, []); return this },
		on(event: string, fn: Function) {
			const list = handlers.get(event) ?? []
			list.push(fn)
			handlers.set(event, list)
			return this
		},
	}
}