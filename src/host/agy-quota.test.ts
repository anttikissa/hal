// Antigravity quota parsing, HOME isolation for geminiDir accounts,
// early abort on auth prompts, /status table and INSPECT subscriptions.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { agy } from './agy.ts'
import { agyAccounts } from './agy-accounts.ts'
import { agyQuota } from './agy-quota.ts'
import { auth } from './auth.ts'
import { clock } from './clock.ts'
import { limits } from './limits.ts'
import { paths } from './paths.ts'
import { statusUsage } from './status-usage.ts'
import { tools } from './tools.ts'

const savedHome = paths.state.home
const origNow = clock.now
const origCmd = agy.command
const origTimeout = agyQuota.timeoutMs
let home = ''
let now = Date.parse('2026-11-26T11:30:00Z')

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-agy-quota-test-`)
	mkdirSync(`${home}/secrets`, { mode: 0o700 })
	paths.state.home = home
	paths.init()
	clock.now = () => now
	agyAccounts.state.chosen.clear()
	agyAccounts.state.picked.clear()
})

afterEach(() => {
	auth.close()
	limits.close()
	agy.command = origCmd
	agyQuota.timeoutMs = origTimeout
	clock.now = origNow
	agyAccounts.state.chosen.clear()
	agyAccounts.state.picked.clear()
	paths.state.home = savedHome
	rmSync(home, { recursive: true, force: true })
})

// Recorded shape of real `agy -p /quota --output-format json` (26 Nov 2026).
const SAMPLE = JSON.stringify({
	conversation_id: '',
	status: 'SUCCESS',
	command: {
		name: 'usage',
		data: {
			groups: [
				{
					name: 'Gemini Models',
					buckets: [
						{
							id: 'gemini-weekly',
							name: 'Weekly Limit Remaining',
							window: 'weekly',
							remaining_fraction: 0.9870044589042664,
							reset_time: '2026-12-03T11:19:33Z',
						},
						{
							id: 'gemini-5h',
							name: 'Five Hour Limit Remaining',
							window: '5h',
							remaining_fraction: 0.9680179357528687,
							reset_time: '2026-11-26T16:19:33Z',
						},
					],
				},
				{
					name: 'Claude and GPT models',
					buckets: [
						{
							id: '3p-weekly',
							name: 'Weekly Limit Remaining',
							window: 'weekly',
							remaining_fraction: 1,
							reset_time: '1970-01-01T00:00:00Z',
						},
						{
							id: '3p-5h',
							name: 'Five Hour Limit Remaining',
							window: '5h',
							remaining_fraction: 0.5,
							reset_time: '1970-01-01T00:00:00Z',
						},
					],
				},
			],
		},
	},
})

test('parse converts remaining_fraction to used percent, drops epoch-zero resets, and separates 3p buckets', () => {
	let w = agyQuota.parse(SAMPLE)
	expect(w['5h']).toEqual({
		used: 3.2,
		resets: '2026-11-26T16:19:33.000Z',
		observed: '2026-11-26T11:30:00.000Z',
	})
	expect(w['7d']).toEqual({
		used: 1.3,
		resets: '2026-12-03T11:19:33.000Z',
		observed: '2026-11-26T11:30:00.000Z',
	})
	expect(w['5h_3p']).toEqual({ used: 50, observed: '2026-11-26T11:30:00.000Z' })
	expect(w['7d_3p']).toEqual({ used: 0, observed: '2026-11-26T11:30:00.000Z' })
	expect(() => agyQuota.parse('not json')).toThrow('invalid JSON')
	expect(() => agyQuota.parse(JSON.stringify({ status: 'ERROR', response: 'boom' }))).toThrow('boom')
})

test('fetch isolates geminiDir via temp HOME/.gemini + SSH_CONNECTION, cleans up, and feeds /status + INSPECT', async () => {
	let dir2 = `${home}/state/agy/second/gemini`
	mkdirSync(dir2, { recursive: true })
	writeFileSync(`${dir2}/marker`, 'second-account')
	let seenHomes: string[] = []
	let fakeAgy = `${home}/fake-agy.ts`
	writeFileSync(
		fakeAgy,
		`import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
let markerPath = join(process.env.HOME ?? '', '.gemini', 'marker')
if (existsSync(markerPath) && readFileSync(markerPath, 'utf8') === 'second-account') {
	if (!process.env.SSH_CONNECTION) { console.error('missing SSH_CONNECTION'); process.exit(2) }
	// Record the temp HOME so the test can confirm cleanup after exit.
	await Bun.write(${JSON.stringify(`${home}/seen-tmp-home`)}, process.env.HOME ?? '')
	process.stdout.write(JSON.stringify({
		status: 'SUCCESS',
		command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [
			{ id: 'gemini-5h', window: '5h', remaining_fraction: 0.4, reset_time: '2026-11-26T16:30:00Z' },
			{ id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.75, reset_time: '2026-12-03T11:30:00Z' },
		] }] } }
	}))
} else {
	process.stdout.write(${JSON.stringify(SAMPLE)})
}
`,
	)
	agy.command = () => [process.execPath, fakeAgy]
	writeFileSync(
		paths.authFile(),
		ason.stringify({
			agy: [
				{ email: 'first@example.com', keychain: true },
				{ email: 'second@example.com', geminiDir: 'state/agy/second/gemini' },
			],
		}) + '\n',
		{ mode: 0o600 },
	)

	let shown = await statusUsage.show('s1', 'agy/gemini-4-neon')
	expect(shown).toContain('Antigravity accounts:')
	expect(shown).toContain('| Slot | Account | 5h | 7d |')
	expect(shown).not.toContain('| Status |')
	expect(shown).toContain('| y1 * | first@example.com |')
	expect(shown).toContain('3% used')
	expect(shown).toContain('1% used')
	expect(shown).toContain('| y2 | second@example.com |')
	expect(shown).toContain('60% used')
	expect(shown).toContain('25% used')

	let seenTmpHome = readFileSync(`${home}/seen-tmp-home`, 'utf8')
	seenHomes.push(seenTmpHome)
	expect(seenTmpHome).not.toBe(process.env.HOME)
	expect(existsSync(seenTmpHome)).toBe(false)

	let inspected = await tools.run(
		{ type: 'tool_call', id: 'i1', name: 'inspect', input: { what: 'subscriptions' } },
		{ cwd: home, signal: new AbortController().signal, sessionId: 's1', model: 'agy/gemini-4-neon' },
	)
	expect(inspected.isError).toBeUndefined()
	expect(inspected.output).toContain('account: first@example.com')
	expect(inspected.output).toContain('5h: 3.2% used; resets 2026-11-26T16:19:33.000Z')
	expect(inspected.output).toContain('5h_3p: 50% used; resets unknown')
	expect(inspected.output).toContain('account: second@example.com')
	expect(inspected.output).toContain('5h: 60% used; resets 2026-11-26T16:30:00.000Z')
	expect(inspected.output).toContain('7d: 25% used; resets 2026-12-03T11:30:00.000Z')
})

test('fetch aborts immediately on auth prompt and /status suggests /login agy', async () => {
	let fakeAgy = `${home}/fake-auth.ts`
	writeFileSync(
		fakeAgy,
		`process.stdout.write('Authentication required. Please visit the URL to log in:\\nWaiting for authentication (timeout 60s)...\\n')
await Bun.sleep(60_000)
`,
	)
	agy.command = () => [process.execPath, fakeAgy]
	agyQuota.timeoutMs = 5_000
	writeFileSync(paths.authFile(), ason.stringify({ agy: { email: 'expired@example.com', keychain: true } }) + '\n', {
		mode: 0o600,
	})

	let started = Date.now()
	let shown = await statusUsage.show('s1', 'agy/gemini-4-neon')
	expect(Date.now() - started).toBeLessThan(3_000)
	expect(shown).toContain('expired@example.com<br>login expired')
	expect(shown).toContain('To log in to expired@example.com again, run /login agy.')
})
