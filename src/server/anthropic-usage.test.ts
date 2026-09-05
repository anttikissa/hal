import { afterEach, beforeEach, expect, test } from 'bun:test'
import { auth, type Credential } from './auth.ts'
import { anthropicUsage } from './anthropic-usage.ts'
import { subscriptionLog } from './subscription-log.ts'
import { subscriptionUsage } from '../common/subscription-usage.ts'
import { ason } from '../utils/ason.ts'

const origFetch = globalThis.fetch
const origListCredentials = auth.listCredentials
const origEnsureFresh = auth.ensureFresh
const origSubscriptionAppend = subscriptionLog.io.append

function makeCredential(index: number, email: string): Credential {
	return {
		value: `tok_${index}`,
		type: 'token',
		email,
		index,
		total: 2,
		_key: `anthropic:${index}`,
	}
}

beforeEach(() => {
	anthropicUsage.init()
	subscriptionLog.io.append = () => {}
})

afterEach(() => {
	globalThis.fetch = origFetch
	auth.listCredentials = origListCredentials
	auth.ensureFresh = origEnsureFresh
	subscriptionLog.io.append = origSubscriptionAppend
	anthropicUsage.state.currentKey = ''
	anthropicUsage.state.accounts = {}
	subscriptionUsage.config.censorEmails = false
	anthropicUsage.config.progressBarWidth = 14
	anthropicUsage.save()
})

test('parsePayload maps the Claude usage payload', () => {
	const snapshot = anthropicUsage.parsePayload(makeCredential(0, 'a@test.com'), {
		five_hour: {
			utilization: 0.23,
			resets_at: '2026-01-07T05:00:00Z',
		},
		seven_day: {
			utilization: 0.61,
			resets_at: '2026-01-08T05:00:00Z',
		},
		seven_day_sonnet: {
			utilization: 0.44,
		},
	})

	expect(snapshot.email).toBe('a@test.com')
	expect(snapshot.fiveHour).toEqual({ usedPercent: 23, resetAt: Date.parse('2026-01-07T05:00:00Z') })
	expect(snapshot.sevenDay).toEqual({ usedPercent: 61, resetAt: Date.parse('2026-01-08T05:00:00Z') })
	expect(snapshot.modelWeek).toEqual({ label: 'Sonnet', usedPercent: 44, resetAt: undefined })
})

test('refreshAll caches all accounts and status text marks the current one', async () => {
	auth.ensureFresh = async () => {}
	auth.listCredentials = () => [makeCredential(0, 'a@test.com'), makeCredential(1, 'b@test.com')]
	anthropicUsage.state.currentKey = 'anthropic:1'

	globalThis.fetch = Object.assign(async (_input: any, init?: RequestInit) => {
		const authz = new Headers(init?.headers).get('authorization')
		const idx = authz?.includes('tok_1') ? 1 : 0
		return new Response(JSON.stringify({
			five_hour: {
				utilization: 0.20 + idx * 0.01,
				resets_at: '2026-01-07T05:00:00Z',
			},
			seven_day: {
				utilization: 0.60 + idx * 0.01,
				resets_at: '2026-01-08T05:00:00Z',
			},
			seven_day_sonnet: {
				utilization: 0.10 + idx * 0.01,
			},
		}), { status: 200 }) as any
	}, { preconnect: () => {} }) as typeof fetch

	await anthropicUsage.refreshAll(true)
	const text = anthropicUsage.formatStatusText()

	expect(text).toContain('Anthropic subscriptions:')
	expect(text).toContain('| Slot | Account | 5h | 7d | Sonnet 7d |')
	expect(text).toContain(`| 1/2 | a@test.com | ${subscriptionUsage.usageBarMarker(20, 14)}`)
	expect(text).toContain('<br>20% used')
	expect(text).toContain(`| 2/2 * | b@test.com | ${subscriptionUsage.usageBarMarker(21, 14)}`)
	expect(text).toContain('<br>61% used')
	expect(text).toContain('<br>11% used')
})

test('refreshAll prunes cached accounts whose credentials are gone', async () => {
	auth.ensureFresh = async () => {}
	// Pre-populate cache with two accounts, but only one credential is currently configured
	anthropicUsage.state.accounts = {
		'anthropic:0': {
			key: 'anthropic:0',
			email: 'a@test.com',
			index: 0,
			total: 2,
			fiveHour: { usedPercent: 10 },
		},
		'anthropic:1': {
			key: 'anthropic:1',
			email: 'b@test.com',
			index: 1,
			total: 2,
			fiveHour: { usedPercent: 20 },
		},
	}
	anthropicUsage.state.currentKey = 'anthropic:1'
	auth.listCredentials = () => [{ ...makeCredential(0, 'a@test.com'), total: 1 }]

	globalThis.fetch = Object.assign(async () => {
		return new Response(JSON.stringify({
			five_hour: { utilization: 0.10, resets_at: '2026-01-07T05:00:00Z' },
		}), { status: 200 }) as any
	}, { preconnect: () => {} }) as typeof fetch

	await anthropicUsage.refreshAll(true)

	expect(anthropicUsage.state.accounts['anthropic:0']).toBeDefined()
	expect(anthropicUsage.state.accounts['anthropic:1']).toBeUndefined()
	// stale currentKey gets cleared
	expect(anthropicUsage.state.currentKey).toBe('anthropic:0')
})

test('formatStatusText can censor emails for screenshot-safe output', () => {
	subscriptionUsage.config.censorEmails = true
	anthropicUsage.state.currentKey = 'anthropic:0'
	anthropicUsage.state.accounts = {
		'anthropic:0': {
			key: 'anthropic:0',
			email: 'antti@lippukiska.fi',
			index: 0,
			total: 2,
			fiveHour: { usedPercent: 68, resetAt: Date.parse('2026-01-07T05:00:00Z') },
			modelWeek: { label: 'Sonnet', usedPercent: 25 },
		},
		'anthropic:1': {
			key: 'anthropic:1',
			email: 'antti.kissaniemi@gmail.com',
			index: 1,
			total: 2,
			sevenDay: { usedPercent: 30, resetAt: Date.parse('2026-01-08T05:00:00Z') },
		},
	}

	const text = anthropicUsage.formatStatusText()

	expect(text).toContain('a\\*\\*\\*@l\\*\\*\\*.fi')
	expect(text).toContain('a\\*\\*\\*@g\\*\\*\\*\\*.com')
	expect(text).toContain(`| 1/2 * | a\\*\\*\\*@l\\*\\*\\*.fi | ${subscriptionUsage.usageBarMarker(68, 14)}`)
})

test('records only changed fresh Anthropic quota observations', async () => {
	auth.ensureFresh = async () => {}
	const credential = { ...makeCredential(0, 'private@test.com'), _key: 'anthropic:private@test.com' }
	auth.listCredentials = () => [credential]
	anthropicUsage.state.accounts[credential._key!] = {
		key: credential._key!,
		fetchedAt: '2026-09-01T00:00:00.000Z',
		fiveHour: { usedPercent: 10, resetAt: Date.parse('2026-09-05T10:00:00Z') },
	}
	const writes: string[] = []
	subscriptionLog.io.append = (_path, text) => writes.push(text)
	let fetches = 0
	globalThis.fetch = Object.assign(async () => {
		fetches++
		return new Response(JSON.stringify({
			five_hour: { utilization: 0.25, resets_at: '2026-09-05T10:00:00Z' },
			seven_day: { utilization: 0.60, resets_at: '2026-09-12T10:00:00Z' },
			seven_day_sonnet: { utilization: 0.15 },
		}), { status: 200 }) as any
	}, { preconnect: () => {} }) as typeof fetch

	await anthropicUsage.refreshAll(true)
	await anthropicUsage.refreshAll(false)
	await anthropicUsage.refreshAll(true)

	expect(fetches).toBe(2)
	expect(writes).toHaveLength(1)
	const entry = ason.parse(writes[0]!) as any
	expect(entry.provider).toBe('anthropic')
	expect(entry.account).toBe(subscriptionLog.accountPseudonym('anthropic', credential._key!))
	expect(entry.windows).toEqual([
		{ label: '5h', durationMinutes: 300, usedPercent: 25, resetAt: Date.parse('2026-09-05T10:00:00Z') },
		{ label: '7d', durationMinutes: 10_080, usedPercent: 60, resetAt: Date.parse('2026-09-12T10:00:00Z') },
		{ label: 'Sonnet 7d', durationMinutes: 10_080, usedPercent: 15 },
	])
})
