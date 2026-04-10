import { afterEach, expect, test } from 'bun:test'
import { auth, type Credential } from './auth.ts'
import { openaiUsage } from './openai-usage.ts'

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
	openaiUsage.state.lastActiveAt = ''
	openaiUsage.state.accounts = {}
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
	expect(snapshot.pendingTokens).toBe(0)
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
	expect(text).toContain('  1/2 a@test.com (plus) · 5h 20% used')
	expect(text).toContain('* 2/2 b@test.com (plus) · 5h 21% used')
	expect(text).toContain('7d 61% used')
})
