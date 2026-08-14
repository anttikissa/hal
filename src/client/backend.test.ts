import { expect, test } from 'bun:test'
import { clientBackend } from './backend.ts'

test('install updates client-facing backend ports', () => {
	const original = clientBackend.sessions.loadAllSessionMetas
	try {
		clientBackend.install({ sessions: { loadAllSessionMetas: () => [{ id: '04-test', createdAt: 'now' }] } })
		expect(clientBackend.sessions.loadAllSessionMetas()).toEqual([{ id: '04-test', createdAt: 'now' }])
	} finally {
		clientBackend.sessions.loadAllSessionMetas = original
	}
})
