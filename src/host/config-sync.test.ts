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
	expect(text).toStartWith('// shared root\n{\n\t// local address\n\twebUrl')
	expect(text).toContain('// unknown stays local')
	expect(text).not.toContain('server address')
	expect(text).not.toContain('old portable comment')
	expect(ason.parse(text)).toEqual({
		webUrl: 'https://local.example.com',
		hostname: 'local',
		model: 'new',
		cardVerbosityShortRows: 3,
	})
	let cleared = configSync.merge(merged, undefined)
	expect(configSync.view(cleared)).toBeUndefined()
	expect(cleared.toString()).toContain('// local address')
	expect(configSync.merge(incoming, undefined).toString()).toBe('{}\n')
	for (let invalid of ['[]', '{ broken', '{ webPort: 9001 }', '{ hostname: "remote" }'])
		expect(() => configSync.merge(local, bytes(invalid))).toThrow()
	expect(() => configSync.merge(bytes('{ broken'), incoming)).toThrow()
})

test('settings merge one by one, from {} without shared history', () => {
	let view = (t: string) => configSync.view(bytes(t))!.toString()
	let air = view(`{ model: 'm', // rows\n cardVerbosityShortRows: 2, security: 'none' }`)
	let server = view(`{ composerDebug: true, model: 'm', webDiagnostics: true }`)
	let m = configSync.combine(undefined, air, server)
	expect(m.conflicts).toBe(0)
	expect(ason.parse(m.text)).toEqual({
		composerDebug: true,
		model: 'm',
		webDiagnostics: true,
		cardVerbosityShortRows: 2,
		security: 'none',
	})
	expect(m.text).toContain('// rows')
	// A value removed on one side since the base stays removed; different
	// values on both sides conflict and keep this computer's.
	let base = view(`{ model: 'm', security: 'none' }`)
	let both = configSync.combine(base, view(`{ model: 'a' }`), view(`{ model: 'b', security: 'none' }`))
	expect(both.conflicts).toBe(1)
	expect(ason.parse(both.text)).toEqual({ model: 'a' })
})
