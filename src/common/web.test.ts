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

test('session routes are the paths the browser app serves itself', () => {
	expect(webProtocol.isSessionPath('/05-wan')).toBe(true)
	expect(webProtocol.isSessionPath('/112-bad')).toBe(true)
	// Real endpoints and unknown paths must keep their own handling, so a typo
	// still 404s instead of silently rendering the app.
	expect(webProtocol.isSessionPath('/')).toBe(false)
	expect(webProtocol.isSessionPath('/main.js')).toBe(false)
	expect(webProtocol.isSessionPath('/styles.css')).toBe(false)
	expect(webProtocol.isSessionPath('/ws')).toBe(false)
	expect(webProtocol.isSessionPath('/upload')).toBe(false)
	expect(webProtocol.isSessionPath('/api/update')).toBe(false)
	expect(webProtocol.isSessionPath('/05-wan/extra')).toBe(false)
})
