import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import type { StreamEvent } from '../common/blocks.ts'
import { tokenEstimates } from '../common/token-estimates.ts'
import { paths } from './paths.ts'
import { provider } from './provider.ts'
import { pruning } from './pruning.ts'
import { tokenCalibration } from './token-calibration.ts'

let home = ''
let savedHome = process.env.HAL_HOME
let savedFetch = provider.fetch
let savedProviders = provider.state.providers
beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-calibration-`)
	process.env.HAL_HOME = home
	paths.init()
})
afterEach(() => {
	provider.fetch = savedFetch
	provider.state.providers = savedProviders
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

test('successful rounds merge cumulative usage, count cached input, and persist isolated, smoothed model ratios', async () => {
	let events: StreamEvent[] = [
		{ type: 'usage', usage: { input: 10, cacheRead: 30 } },
		{ type: 'usage', usage: { output: 9, cacheWrite: 10 } },
		{ type: 'done', reason: 'end' },
	]
	provider.state.providers = { fake: {
		request: () => ({ url: 'https://example.test', headers: {}, body: {} }),
		async *parse() { yield* events },
	} }
	provider.fetch = async () => new Response('data: ignored\n\n')
	let input = { system: 'system', messages: [{ role: 'user' as const, blocks: [{ type: 'text' as const, text: 'x'.repeat(500) }] }] }
	let before = pruning.estimate('none', input.messages, input.system.length + 2, 'fake/a')
	for await (let _event of provider.stream('fake/a', input)) { /* drain */ }
	let chars = tokenEstimates.characters(input.messages, input.system.length + 2)
	expect(tokenCalibration.ratios()['fake/a']).toBe(chars / 50)
	expect(pruning.estimate('none', input.messages, input.system.length + 2, 'fake/a')).toBe(50)
	expect(pruning.estimate('none', input.messages, input.system.length + 2, 'fake/b')).toBe(before)
	let previous = tokenCalibration.ratios()['fake/a']!
	tokenCalibration.observe('fake/a', 1e9, 1)
	expect(tokenCalibration.ratios()['fake/a']).toBeCloseTo(previous * 1.025)
	// Errors and image rounds cannot poison the text ratio.
	events = [{ type: 'usage', usage: { input: 1 } }, { type: 'error', message: 'broken' }]
	for await (let _event of provider.stream('fake/b', input)) { /* drain */ }
	events = [{ type: 'usage', usage: { input: 1 } }, { type: 'done', reason: 'end' }]
	for await (let _event of provider.stream('fake/b', { messages: [{ role: 'user', blocks: [{ type: 'image', blob: 'img', mediaType: 'image/png' }] }] })) { /* drain */ }
	expect(tokenCalibration.ratios()['fake/b']).toBeUndefined()
})

test('malformed persisted calibration names its path and is not overwritten', () => {
	let file = `${paths.stateDir()}/calibration.ason`
	writeFileSync(file, "{ 'fake/a': 0 }")
	expect(() => tokenCalibration.estimateTokens(100, 'fake/a')).toThrow(`${file}: invalid characters-per-token ratio`)
	expect(() => tokenCalibration.observe('fake/a', 100, 20)).toThrow(file)
})
