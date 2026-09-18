import { afterEach, beforeEach, expect, test } from 'bun:test'
import { auth, type Credential } from './auth.ts'
import { opencodeUsage } from './opencode-usage.ts'
import { subscriptionLog } from './subscription-log.ts'
import { ensureStateDir } from './state.ts'

const origFetch = globalThis.fetch
const origListCredentials = auth.listCredentials
const origAppend = subscriptionLog.io.append

beforeEach(() => {
	// The real app creates the state dir at startup; without it the liveFile cache
	// cannot flush and every save throws.
	ensureStateDir()
	subscriptionLog.io.append = () => {}
})

afterEach(() => {
	globalThis.fetch = origFetch
	auth.listCredentials = origListCredentials
	subscriptionLog.io.append = origAppend
	opencodeUsage.state.currentKey = ''
	opencodeUsage.state.accounts = {}
})

function installFetchMock(fn: (input: any, init?: RequestInit) => Promise<Response>): void {
	globalThis.fetch = Object.assign(fn, { preconnect: () => {} }) as typeof fetch
}

function makeCredential(index: number, total = 2): Credential {
	return { value: `sk-go-${index}`, type: 'api-key', index, total, _key: `opencode-go:${index}` }
}

/** Shape returned by opencode.ai/zen/go/v1/usage. */
function usagePayload(percent: number, resetsAt: string, status = 'ok') {
	return {
		usage: {
			rolling: { status, percent, resetsAt },
			weekly: { status: 'ok', percent: 50, resetsAt },
			monthly: { status: 'ok', percent: 25, resetsAt },
		},
	}
}

test('parsePayload maps the Go usage windows and their reset times', () => {
	const resetsAt = '2026-09-18T14:20:00.000Z'
	const account = opencodeUsage.parsePayload(makeCredential(0), usagePayload(81, resetsAt))

	expect(account.rolling?.usedPercent).toBe(81)
	expect(account.weekly?.usedPercent).toBe(50)
	expect(account.monthly?.usedPercent).toBe(25)
	expect(account.rolling?.resetAt).toBe(Date.parse(resetsAt))
	expect(account.index).toBe(0)
	expect(account.total).toBe(2)
})

test('observationWindows reports 5h, 7d and 30d for rotation accounting', () => {
	const account = opencodeUsage.parsePayload(makeCredential(0), usagePayload(81, '2026-09-18T14:20:00.000Z'))
	const windows = opencodeUsage.observationWindows(account)

	expect(windows.map((w) => w.label)).toEqual(['5h', '7d', '30d'])
	expect(windows.map((w) => w.durationMinutes)).toEqual([300, 10_080, 43_200])
	expect(windows[0]!.usedPercent).toBe(81)
})

test('refreshAll stores usage per account and rotates between them', async () => {
	auth.listCredentials = () => [makeCredential(0), makeCredential(1)]
	installFetchMock(async () => new Response(JSON.stringify(usagePayload(81, '2026-09-18T14:20:00.000Z'))))

	await opencodeUsage.refreshAll(true)

	expect(opencodeUsage.all()).toHaveLength(2)
	// First configured credential becomes current so the status bar has something.
	expect(opencodeUsage.state.currentKey).toBe('opencode-go:0')

	opencodeUsage.setCurrentCredential(makeCredential(1))
	expect(opencodeUsage.current()?.index).toBe(1)
})

test('a key without a Go subscription reports the entitlement error plainly', async () => {
	auth.listCredentials = () => [makeCredential(0, 1)]
	installFetchMock(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'EntitlementError', message: 'OpenCode Go subscription required.' } }), { status: 403 }))

	const text = await opencodeUsage.renderStatus(true)
	expect(text).toContain('No OpenCode Go subscription for this key')
})

test('an unauthorized key surfaces the 401 instead of a generic failure', async () => {
	auth.listCredentials = () => [makeCredential(0, 1)]
	installFetchMock(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'AuthError', message: 'Unauthorized' } }), { status: 401 }))

	const text = await opencodeUsage.renderStatus(true)
	expect(text).toContain('401')
})

test('status text renders the windows and marks the current account', async () => {
	auth.listCredentials = () => [makeCredential(0), makeCredential(1)]
	installFetchMock(async () => new Response(JSON.stringify(usagePayload(81, '2026-09-18T14:20:00.000Z'))))
	await opencodeUsage.refreshAll(true)

	const text = opencodeUsage.formatStatusText()
	expect(text).toContain('OpenCode Go subscriptions:')
	expect(text).toContain('| Slot | Account | 5h | 7d | 30d |')
	expect(text).toContain('81% used')
	expect(text).toContain('1/2 *')
})

test('with no key configured, status says so without calling the API', async () => {
	auth.listCredentials = () => []
	let called = false
	installFetchMock(async () => {
		called = true
		return new Response('{}')
	})

	expect(await opencodeUsage.renderStatus(true)).toBe('No OpenCode Go subscriptions configured.')
	expect(called).toBe(false)
})
