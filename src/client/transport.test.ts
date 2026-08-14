import { expect, test } from 'bun:test'
import { clientTransport } from './transport.ts'

test('install updates the client transport without importing its implementation', () => {
	const original = clientTransport.io.appendCommand
	const commands: unknown[] = []
	try {
		clientTransport.install({ appendCommand: (command) => { commands.push(command) } })
		clientTransport.io.appendCommand({ type: 'close', sessionId: '04-test' })
		expect(commands).toEqual([{ type: 'close', sessionId: '04-test' }])
	} finally {
		clientTransport.io.appendCommand = original
	}
})
