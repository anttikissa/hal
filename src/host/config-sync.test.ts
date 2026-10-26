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
