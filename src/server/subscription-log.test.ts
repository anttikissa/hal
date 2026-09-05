import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ason } from '../utils/ason.ts'
import { log } from '../utils/log.ts'
import { subscriptionLog } from './subscription-log.ts'

const originalPath = subscriptionLog.state.path
const originalAppend = subscriptionLog.io.append
const originalNow = subscriptionLog.io.now
const originalLogError = log.error
let tempDir = ''

afterEach(() => {
	subscriptionLog.state.path = originalPath
	subscriptionLog.io.append = originalAppend
	log.error = originalLogError
	subscriptionLog.io.now = originalNow
	if (tempDir) rmSync(tempDir, { recursive: true, force: true })
	tempDir = ''
})

function useTempLog(): string {
	tempDir = mkdtempSync(join(tmpdir(), 'hal-subscription-log-'))
	const path = join(tempDir, 'subscription-usage.asonl')
	subscriptionLog.state.path = path
	return path
}

test('appends a pseudonymous ASONL observation when quota state changes', () => {
	const path = useTempLog()
	const previous = [{ label: '5h', durationMinutes: 300, usedPercent: 10, resetAt: Date.parse('2026-09-05T10:00:00.000Z') }]
	const current = [{ label: '5h', durationMinutes: 300, usedPercent: 25, resetAt: Date.parse('2026-09-05T10:00:00.000Z') }]

	subscriptionLog.io.now = () => '2026-09-05T06:11:00.000Z'
	subscriptionLog.observe('openai', 'openai:person@example.com', current, previous)

	const [entry] = ason.parseAll(readFileSync(path, 'utf8')) as any[]
	expect(entry).toEqual({
		ts: '2026-09-05T06:11:00.000Z',
		provider: 'openai',
		account: subscriptionLog.accountPseudonym('openai', 'openai:person@example.com'),
		windows: current,
	})
	expect(entry.account).not.toContain('person')
	expect(entry.account).not.toContain('@')
})

test('does not append an unchanged or empty quota observation', () => {
	const writes: string[] = []
	subscriptionLog.io.append = (_path, text) => writes.push(text)
	const windows = [{ label: '7d', durationMinutes: 10_080, usedPercent: 61, resetAt: Date.parse('2026-09-12T00:00:00.000Z') }]

	subscriptionLog.observe('anthropic', 'anthropic:account-id', windows, windows)
	subscriptionLog.observe('anthropic', 'anthropic:account-id', [], [])

	expect(writes).toEqual([])
})

test('reports append failures without throwing', () => {
	const diagnostics: { message: string; data: Record<string, unknown> | undefined }[] = []
	subscriptionLog.io.append = () => { throw new Error('disk full') }
	log.error = (message, data) => diagnostics.push({ message, data })

	expect(() => subscriptionLog.observe('openai', 'openai:0', [
		{ label: '5h', durationMinutes: 300, usedPercent: 10, resetAt: Date.parse('2026-09-05T10:00:00.000Z') },
	])).not.toThrow()
	expect(diagnostics).toEqual([{
		message: 'Failed to write subscription usage observation',
		data: { provider: 'openai', message: 'disk full' },
	}])
})
