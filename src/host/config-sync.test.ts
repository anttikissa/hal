// Portable config views preserve ASON's supported comments without copying local keys.
import { expect, test } from 'bun:test'
import { ason } from '../common/ason.ts'
import { configSync } from './config-sync.ts'

const bytes = (text: string) => Buffer.from(text)

test('portable views and merges keep key order and comment ownership', () => {
	let local = bytes(`// old root
{
	// local address
	webUrl: 'https://local.example.com',
	// legacy setting
	blockVerbosityShortRows: 2,
	// unknown stays local
	hostname: 'local',
	// old portable comment
	model: 'old'
}`)
	let incoming = configSync.view(
		bytes(`// shared root
{
	// incoming model
	model: 'new',
	// incoming rows
	cardVerbosityShortRows: 3,
	// server address
	webUrl: 'https://server.example.com'
}`),
	)!
	let merged = configSync.merge(local, incoming)
	expect(configSync.view(merged)).toEqual(incoming)
	let text = merged.toString()
	expect(text).toStartWith('// shared root\n')
	expect(text).toContain('// local address')
	expect(text).toContain('// unknown stays local')
	expect(text).not.toContain('server address')
	expect(text).not.toContain('old portable comment')
	expect(ason.parse(text)).toEqual({
		model: 'new',
		cardVerbosityShortRows: 3,
		webUrl: 'https://local.example.com',
		hostname: 'local',
	})
	let cleared = configSync.merge(merged, undefined)
	expect(configSync.view(cleared)).toBeUndefined()
	expect(cleared.toString()).toContain('// local address')
	expect(configSync.merge(incoming, undefined).toString()).toBe('{}\n')
	let commentsOnly = configSync.view(bytes('// shared root\n{}'))!
	expect(commentsOnly).toBeDefined()
	expect(configSync.view(configSync.merge(local, commentsOnly))).toEqual(commentsOnly)
	for (let invalid of ['[]', '{ broken', '{ webPort: 9001 }', '{ hostname: "remote" }'])
		expect(() => configSync.merge(local, bytes(invalid))).toThrow()
	expect(() => configSync.merge(bytes('{ broken'), incoming)).toThrow()
})

test('settings merge per key: one-sided changes and removals win; differing changes conflict', () => {
	let base = `{ maxRounds: 5, model: 'a', promptRows: 3, security: 'none' }`
	let client = `// mine\n{ maxRounds: 5, model: 'b', promptRows: 4, push: true }`
	let server = `{ maxRounds: 5, model: 'a', promptRows: 9, security: 'none', webDiagnostics: true }`
	let m = configSync.combine(base, client, server)
	expect(m.conflicts).toEqual([{ key: 'promptRows', client: '4', server: '9' }])
	expect(ason.parse(m.text)).toEqual({ maxRounds: 5, model: 'b', promptRows: 4, push: true, webDiagnostics: true })
	expect(m.text).toStartWith('// mine\n')
	let unrelated = configSync.combine(undefined, `{ model: 'a', push: true }`, `{ model: 'a', security: 'none' }`)
	expect([unrelated.conflicts, unrelated.fromClient, unrelated.fromServer]).toEqual([[], 1, 1])
	expect(ason.parse(unrelated.text)).toEqual({ model: 'a', push: true, security: 'none' })
})
