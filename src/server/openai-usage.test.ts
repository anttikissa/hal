import { afterEach, expect, test } from 'bun:test'
import { auth, type Credential } from './auth.ts'
import { openaiUsage } from './openai-usage.ts'
import { subscriptionUsage } from '../common/subscription-usage.ts'

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
		_key: `openai:${index}`,
	}
}

afterEach(() => {
	globalThis.fetch = origFetch
	auth.listCredentials = origListCredentials
	auth.ensureFresh = origEnsureFresh
	openaiUsage.state.currentKey = ''
	openaiUsage.state.accounts = {}
	subscriptionUsage.config.censorEmails = false
	openaiUsage.config.progressBarWidth = 14
	openaiUsage.save()
})

test('parsePayload maps the ChatGPT rate-limit payload', () => {
	const snapshot = openaiUsage.parsePayload(makeCredential(0, 'a@test.com'), {
		email: 'a@test.com',
		plan_type: 'plus',
		rate_limit: {
			primary_window: {
				used_percent: 23,
				limit_window_seconds: 18_000,
				reset_at: 1_775_836_198,
			},
			secondary_window: {
				used_percent: 61,
				limit_window_seconds: 604_800,
				reset_at: 1_776_368_540,
			},
		},
	})

	expect(snapshot.email).toBe('a@test.com')
	expect(snapshot.planType).toBe('plus')
	expect(snapshot.primary).toEqual({ usedPercent: 23, windowMinutes: 300, resetAt: 1_775_836_198 })
	expect(snapshot.secondary).toEqual({ usedPercent: 61, windowMinutes: 10_080, resetAt: 1_776_368_540 })
})

test('formatStatusText labels OpenAI windows from their returned duration', () => {
	openaiUsage.state.currentKey = 'openai:0'
	openaiUsage.state.accounts = {
		'openai:0': {
			key: 'openai:0',
			email: 'a@test.com',
			index: 0,
			total: 1,
			planType: 'plus',
			primary: { usedPercent: 24, windowMinutes: 10_080, resetAt: 1_775_836_198 },
		},
	}

	const text = openaiUsage.formatStatusText()

	expect(text).toContain('| Slot | Account | 7d |')
	expect(text).not.toContain('| Slot | Account | 5h | 7d |')
	expect(text).not.toContain('| ? |')
	expect(text).toContain('<br>24% used')
})
test('hides a shorter window behind an exhausted longer window', () => {
	openaiUsage.state.currentKey = 'openai:0'
	openaiUsage.state.accounts = {
		'openai:0': {
			key: 'openai:0',
			email: 'a@test.com',
			index: 0,
			total: 1,
			pendingTokens: 0,
			primary: { usedPercent: 0, windowMinutes: 300, resetAt: 1_775_836_198 },
			secondary: { usedPercent: 100, windowMinutes: 10_080, resetAt: 1_776_368_540 },
		},
	}

	const text = openaiUsage.formatStatusText()

	expect(text).toContain('| Slot | Account | 7d |')
	expect(text).not.toContain('5h')
	expect(text).not.toContain('<br>0% used')
	expect(text).toContain('100% used')
})

test('refreshAll caches all accounts and status text marks the current one', async () => {
	auth.ensureFresh = async () => {}
	auth.listCredentials = () => [makeCredential(0, 'a@test.com'), makeCredential(1, 'b@test.com')]
	openaiUsage.state.currentKey = 'openai:1'

	globalThis.fetch = Object.assign(async (_input: any, init?: RequestInit) => {
		const authz = new Headers(init?.headers).get('authorization')
		const idx = authz?.includes('tok_1') ? 1 : 0
		return new Response(JSON.stringify({
			email: idx === 0 ? 'a@test.com' : 'b@test.com',
			plan_type: 'plus',
			rate_limit: {
				primary_window: {
					used_percent: 20 + idx,
					limit_window_seconds: 18_000,
					reset_at: Math.floor(Date.now() / 1000) + 1800,
				},
				secondary_window: {
					used_percent: 60 + idx,
					limit_window_seconds: 604_800,
					reset_at: Math.floor(Date.now() / 1000) + 86_400,
				},
			},
		}), { status: 200 }) as any
	}, { preconnect: () => {} }) as typeof fetch

	await openaiUsage.refreshAll(true)
	const text = openaiUsage.formatStatusText()

	expect(text).toContain('OpenAI subscriptions:')
	expect(text).toContain('| Slot | Account | 5h | 7d |')
	expect(text).toContain(`| 1/2 | a@test.com (plus) | ${subscriptionUsage.usageBarMarker(20, 14)}`)
	expect(text).toContain('<br>20% used (resets ')
	expect(text).toContain(`| 2/2 * | b@test.com (plus) | ${subscriptionUsage.usageBarMarker(21, 14)}`)
	expect(text).toContain('<br>61% used (resets ')
	expect(text).not.toContain('\x1b[')
})

test('status table identifies every account whose token expired', async () => {
	auth.ensureFresh = async () => {}
	auth.listCredentials = () => [makeCredential(0, 'expired@test.com'), makeCredential(1, 'valid@test.com')]
	globalThis.fetch = Object.assign(async (_input: any, init?: RequestInit) => {
		const token = new Headers(init?.headers).get('authorization')
		if (token?.includes('tok_0')) return new Response(JSON.stringify({ error: { code: 'token_expired' } }), { status: 401 }) as any
		return new Response(JSON.stringify({
			email: 'valid@test.com',
			plan_type: 'plus',
			rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 1800 } },
		}), { status: 200 }) as any
	}, { preconnect: () => {} }) as typeof fetch

	await openaiUsage.refreshAll(true)
	const text = openaiUsage.formatStatusText()

	expect(text).toContain('| 1/2 * | expired@test.com<br>Token expired — sign in again with /login chatgpt | ? |')
	expect(text).toContain('| 2/2 | valid@test.com (plus) |')
})

test('refreshAll drops cached rows for old credential keys', async () => {
	auth.ensureFresh = async () => {}
	auth.listCredentials = () => [
		{ ...makeCredential(0, 'a@test.com'), _key: 'openai:acct_a' },
		{ ...makeCredential(1, 'b@test.com'), _key: 'openai:acct_b' },
	]
	openaiUsage.state.accounts = {
		'openai:1': {
			key: 'openai:1',
			index: 1,
			total: 2,
			primary: { usedPercent: 23, windowMinutes: 300, resetAt: 1 },
		},
	}

	globalThis.fetch = Object.assign(async (_input: any, init?: RequestInit) => {
		const authz = new Headers(init?.headers).get('authorization')
		const idx = authz?.includes('tok_1') ? 1 : 0
		return new Response(JSON.stringify({
			email: idx === 0 ? 'a@test.com' : 'b@test.com',
			plan_type: 'plus',
			rate_limit: {
				primary_window: {
					used_percent: idx,
					limit_window_seconds: 18_000,
					reset_at: Math.floor(Date.now() / 1000) + 1800,
				},
			},
		}), { status: 200 }) as any
	}, { preconnect: () => {} }) as typeof fetch

	await openaiUsage.refreshAll(true)

	expect(openaiUsage.state.accounts['openai:1']).toBeUndefined()
	expect(openaiUsage.formatStatusText()).not.toContain('| 2/2 | account 2/2 |')
	expect(openaiUsage.formatStatusText()).toContain('| 2/2 | b@test.com (plus) |')
})

	test('refreshAll clears cooldown for accounts with remaining quota', async () => {
		const origClearCooldown = auth.clearCooldown
		const cleared: Credential[] = []
		auth.ensureFresh = async () => {}
		const credential = { ...makeCredential(0, 'a@test.com'), _key: 'openai:acct_a' }
		auth.listCredentials = () => [credential]
		auth.clearCooldown = (cred) => { cleared.push(cred) }
		globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({
			email: 'a@test.com',
			plan_type: 'plus',
			rate_limit: {
				primary_window: {
					used_percent: 20,
					limit_window_seconds: 18_000,
					reset_at: Math.floor(Date.now() / 1000) + 1800,
				},
				secondary_window: {
					used_percent: 60,
					limit_window_seconds: 604_800,
					reset_at: Math.floor(Date.now() / 1000) + 86_400,
				},
			},
		}), { status: 200 }) as any, { preconnect: () => {} }) as typeof fetch
		try {
			await openaiUsage.refreshAll(true)
			expect(cleared).toEqual([credential])
		} finally {
			auth.clearCooldown = origClearCooldown
		}
	})


test('formatStatusText can censor emails for screenshot-safe output', () => {
	subscriptionUsage.config.censorEmails = true
	openaiUsage.state.currentKey = 'openai:0'
	openaiUsage.state.accounts = {
		'openai:0': {
			key: 'openai:0',
			email: 'antti@lippukiska.fi',
			index: 0,
			total: 3,
			planType: 'plus',
			primary: { usedPercent: 68, windowMinutes: 300, resetAt: 1_775_836_198 },
		},
		'openai:1': {
			key: 'openai:1',
			email: 'antti.kissaniemi@gmail.com',
			index: 1,
			total: 3,
			planType: 'plus',
			primary: { usedPercent: 0, windowMinutes: 300, resetAt: 1_775_836_198 },
		},
		'openai:2': {
			key: 'openai:2',
			email: 'lex.michaelis@gmail.com',
			index: 2,
			total: 3,
			planType: 'plus',
			primary: { usedPercent: 0, windowMinutes: 300, resetAt: 1_775_836_198 },
		},
	}

	const text = openaiUsage.formatStatusText()

	expect(text).toContain('a\\*\\*\\*@l\\*\\*\\*.fi')
	expect(text).toContain('a\\*\\*\\*@g\\*\\*\\*\\*.com')
	expect(text).toContain('l\\*\\*\\*@g\\*\\*\\*\\*.com')
	expect(text).toContain(`| 1/3 * | a\\*\\*\\*@l\\*\\*\\*.fi (plus) | ${subscriptionUsage.usageBarMarker(68, 14)}`)
	expect(text).toContain('<br>68% used (resets ')
	expect(text).not.toContain('\x1b[')
})
