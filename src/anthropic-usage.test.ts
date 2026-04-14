import { afterEach, expect, test } from 'bun:test'
import { auth, type Credential } from './auth.ts'
import { anthropicUsage } from './anthropic-usage.ts'
import { subscriptionUsage } from './subscription-usage.ts'

const origFetch = globalThis.fetch
const origListCredentials = auth.listCredentials
const origEnsureFresh = auth.ensureFresh

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

afterEach(() => {
	globalThis.fetch = origFetch
	auth.listCredentials = origListCredentials
	auth.ensureFresh = origEnsureFresh
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
	expect(text).toContain('| Slot | Account | 5h | Week | Sonnet week |')
	expect(text).toContain('| 1/2 | a@test.com | [')
	expect(text).toContain('<br>20% used')
	expect(text).toContain('| 2/2 * | b@test.com | [')
	expect(text).toContain('<br>61% used')
	expect(text).toContain('<br>11% used')
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
			pendingTokens: 0,
			fiveHour: { usedPercent: 68, resetAt: Date.parse('2026-01-07T05:00:00Z') },
			modelWeek: { label: 'Sonnet', usedPercent: 25 },
		},
		'anthropic:1': {
			key: 'anthropic:1',
			email: 'antti.kissaniemi@gmail.com',
			index: 1,
			total: 2,
			pendingTokens: 0,
			sevenDay: { usedPercent: 30, resetAt: Date.parse('2026-01-08T05:00:00Z') },
		},
	}

	const text = anthropicUsage.formatStatusText()

	expect(text).toContain('a***@l***.fi')
	expect(text).toContain('a***@g****.com')
	expect(text).toContain('| 1/2 * | a***@l***.fi | [')
})
