import { expect, test } from 'bun:test'
import { webProtocol, type WebServerMessage } from './web.ts'

const authenticated: WebServerMessage = {
	type: 'authenticated',
	bootstrap: {
		state: { sessions: [], working: {}, updatedAt: '' },
		metas: [],
		snapshots: [],
	},
}

test('web protocol uses ASON directly', () => {
	const text = webProtocol.encode(authenticated)
	expect(text).toBe("{ type: 'authenticated', bootstrap: { state: { sessions: [], working: {}, updatedAt: '' }, metas: [], snapshots: [] } }")
	expect(webProtocol.decode(text)).toEqual(authenticated)
})

test('web protocol rejects malformed ASON', () => {
	expect(webProtocol.decode('{ nope')).toBeNull()
})
