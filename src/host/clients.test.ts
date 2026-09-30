import { afterEach, expect, test } from 'bun:test'
import { ason } from '../common/ason.ts'
import { clients } from './clients.ts'
import { host } from './host.ts'

afterEach(() => host.reset())

test('the diagram lists live peers beside the host and others below, gone ones marked, and forgets after a day', () => {
	let now = Date.now()
	let real = Date.now
	try {
		let wire = (info: Parameters<typeof clients.join>[1]) => host.adapt(() => {}, info)
		let peer = wire({ kind: 'peer' })
		peer.receive(ason.stringify({ type: 'hello', pid: 4242 }, 'short'))
		let remote = wire({ kind: 'remote', address: '203.0.113.7', userAgent: 'hal-terminal' })
		let web = wire({ kind: 'web', address: '198.51.100.4', userAgent: 'Mozilla/5.0 (iPhone) Safari/604.1' })
		web.close()
		clients.tty = () => 'ttys003'
		let text = clients.draw()
		let lines = text.split('\n')
		expect(lines[0]).toMatch(/^host \d+ .* \(up .*\)  <->  peer 4242 ttys003$/)
		expect(text).toContain('remote terminal 203.0.113.7')
		expect(text).toContain('web 198.51.100.4 Safari on iPhone')
		expect(lines.at(-1)).toMatch(/^ {4}└── web .* now \(gone\)$/)
		expect(text).not.toContain('(gone)\n')
		// The same browser coming back replaces its gone entry.
		wire({ kind: 'web', address: '198.51.100.4', userAgent: 'Mozilla/5.0 (iPhone) Safari/604.1' })
		expect(clients.draw()).not.toContain('(gone)')
		// A day later a peer that left is forgotten.
		peer.close()
		expect(clients.draw()).toContain('peer 4242 ttys003  ')
		Date.now = () => now + 25 * 3600_000
		expect(clients.draw()).not.toContain('peer 4242')
		remote.close()
	} finally {
		Date.now = real
		delete (clients as any).tty
	}
})

test('a reported timezone is kept only when valid, and a session hears its latest sender, else a follower', () => {
	let a = clients.join(new Set(['s1'])), b = clients.join(new Set(['s1']))
	clients.input(a, { type: 'tab-start', timezone: 'Europe/Helsinki' })
	for (let bad of ['+05:30', 'UTC+02:00', 'Mars/Olympus', 'x'.repeat(100), 7]) {
		clients.input(b, { type: 'tab-resume', timezone: bad })
		expect(b.timezone).toBeUndefined()
	}
	clients.input(b, { type: 'tab-start', timezone: 'America/New_York' })
	// No input yet: a connected follower's zone.
	expect([a.timezone, b.timezone]).toContain(clients.timezone('s1'))
	clients.input(b, { type: 'submit', sessionId: 's1' })
	expect(clients.timezone('s1')).toBe('America/New_York')
	clients.input(a, { type: 'answer', sessionId: 's1' })
	expect(clients.timezone('s1')).toBe('Europe/Helsinki')
	expect(clients.timezone('s2')).toBeUndefined()
	expect(clients.utcLike('Etc/UTC') && clients.utcLike('GMT') && !clients.utcLike('Europe/London')).toBe(true)
})
