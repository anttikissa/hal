import { expect, test } from 'bun:test'
import { clientCommands } from './commands.ts'

test('prompt commands originate a history-style ID', () => {
	expect(clientCommands.makeCommand('prompt', 's1', 'hello')).toMatchObject({ id: expect.stringMatching(/^[a-z0-9]{6}-[a-z0-9]{3}$/) })
})

test('rebase apply command carries todo and edit payloads', () => {
	const command = clientCommands.makeCommand('rebase-apply', 's1', JSON.stringify({ todo: 'edit 000001-aaa user x', edits: { '000001-aaa': 'edited text' } }), 'r1')

	expect(command).toMatchObject({
		type: 'rebase-apply',
		sessionId: 's1',
		requestId: 'r1',
		todo: 'edit 000001-aaa user x',
		edits: { '000001-aaa': 'edited text' },
	})
})
