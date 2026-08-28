import { beforeEach, describe, expect, test } from 'bun:test'
import { auth } from './auth.ts'
import { authLogin } from './auth-login.ts'

const originalFetch = globalThis.fetch

test('uses OpenAI device authorization for ChatGPT login', async () => {
	auth._setStoreForTest({})
	const requests: Array<{ url: string; init?: RequestInit }> = []
	const originalTryOpenBrowser = authLogin.tryOpenBrowser
	globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input)
		requests.push({ url, init })
		if (url.endsWith('/deviceauth/usercode')) return new Response(JSON.stringify({ device_auth_id: 'device-auth-id', user_code: 'ABCD-EFGH', interval: '0' }))
		if (url.endsWith('/deviceauth/token')) return new Response(JSON.stringify({ authorization_code: 'authorization-code', code_challenge: 'challenge', code_verifier: 'verifier' }))
		return new Response(JSON.stringify({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 }))
	}, { preconnect: () => {} }) as typeof fetch
	authLogin.tryOpenBrowser = () => {}
	try {
		await authLogin.loginOpenai()
		const userCode = JSON.parse(String(requests[0]?.init?.body))
		const tokenPoll = JSON.parse(String(requests[1]?.init?.body))
		const tokenExchange = new URLSearchParams(String(requests[2]?.init?.body))
		expect(userCode).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' })
		expect(tokenPoll).toEqual({ device_auth_id: 'device-auth-id', user_code: 'ABCD-EFGH' })
		expect(Object.fromEntries(tokenExchange)).toMatchObject({ grant_type: 'authorization_code', code: 'authorization-code', code_verifier: 'verifier', redirect_uri: 'https://auth.openai.com/deviceauth/callback' })
		expect(auth.store().openai).toMatchObject({ accessToken: 'access-token', refreshToken: 'refresh-token' })
	} finally {
		globalThis.fetch = originalFetch
		authLogin.tryOpenBrowser = originalTryOpenBrowser
	}
})
test('finishes Claude login after a restart using the verifier returned in code state', async () => {
	auth._setStoreForTest({})
	const verifier = 'A'.repeat(43)
	const requests: Array<{ url: string; init?: RequestInit }> = []
	globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input)
		requests.push({ url, init })
		if (url.includes('/oauth/token')) return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }))
		return new Response(JSON.stringify({ account: { email: 'restart@example.com' } }))
	}, { preconnect: () => {} }) as typeof fetch
	try {
		expect(await authLogin.finishAnthropic(`authorization-code#${verifier}`)).toEqual({ email: 'restart@example.com' })
		const body = JSON.parse(String(requests[0]?.init?.body))
		expect(body).toMatchObject({ code: 'authorization-code', state: verifier, code_verifier: verifier })
		expect(auth.store().anthropic).toMatchObject({ accessToken: 'access', refreshToken: 'refresh', email: 'restart@example.com' })
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('rejects malformed returned Claude state before token exchange', async () => {
	await expect(authLogin.finishAnthropic('authorization-code#short')).rejects.toThrow(/Invalid Claude login code/)
})

describe('authLogin.saveAuth', () => {
	beforeEach(() => {
		auth._setStoreForTest({})
	})

	test('converts a single account to an account list when a different account logs in', () => {
		for (const provider of ['anthropic', 'openai'] as const) {
			const existing = {
				accessToken: `${provider}-old-token`,
				refreshToken: `${provider}-old-refresh`,
				email: 'first@example.com',
				metadata: { retained: true },
			}
			const entry = {
				accessToken: `${provider}-new-token`,
				refreshToken: `${provider}-new-refresh`,
				email: 'second@example.com',
			}
			auth._setStoreForTest({ [provider]: existing })

			authLogin.saveAuth(provider, entry)

			expect(auth.store()[provider]).toEqual([existing, entry])
		}
	})

	test('merges a reauthenticated stable account without duplicating it', () => {
		const matching = {
			accountId: 'acct_same',
			accessToken: 'old-token',
			refreshToken: 'old-refresh',
			email: 'same@example.com',
			metadata: { retained: true },
		}
		const other = {
			accountId: 'acct_other',
			accessToken: 'other-token',
			metadata: { untouched: true },
		}
		auth._setStoreForTest({ openai: [matching, other] })

		authLogin.saveAuth('openai', {
			accountId: 'acct_same',
			accessToken: 'new-token',
			refreshToken: 'new-refresh',
		})

		expect(auth.store().openai).toEqual([
			{
				accountId: 'acct_same',
				accessToken: 'new-token',
				refreshToken: 'new-refresh',
				email: 'same@example.com',
				metadata: { retained: true },
			},
			other,
		])
	})

	test('merges a reauthenticated single account without converting it to a duplicate', () => {
		auth._setStoreForTest({
			openai: {
				accountId: 'acct_same',
				accessToken: 'old-token',
				metadata: { retained: true },
			},
		})

		authLogin.saveAuth('openai', {
			accountId: 'acct_same',
			accessToken: 'new-token',
			refreshToken: 'new-refresh',
		})

		expect(auth.store().openai).toEqual({
			accountId: 'acct_same',
			accessToken: 'new-token',
			refreshToken: 'new-refresh',
			metadata: { retained: true },
		})
	})

	test('merges a reauthenticated Anthropic account by email', () => {
		auth._setStoreForTest({
			anthropic: {
				email: 'same@example.com',
				accessToken: 'old-token',
				metadata: { retained: true },
			},
		})

		authLogin.saveAuth('anthropic', {
			email: 'same@example.com',
			accessToken: 'new-token',
			refreshToken: 'new-refresh',
		})

		expect(auth.store().anthropic).toEqual({
			email: 'same@example.com',
			accessToken: 'new-token',
			refreshToken: 'new-refresh',
			metadata: { retained: true },
		})
	})
})
