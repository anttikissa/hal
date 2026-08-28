import { beforeEach, describe, expect, test } from 'bun:test'
import { auth } from './auth.ts'
import { authLogin } from './auth-login.ts'
import { webUpload } from './web-upload.ts'

const originalFetch = globalThis.fetch

test('uses the configured public DNS hostname for the ChatGPT callback', () => {
	const originalHostname = webUpload.config.hostname
	webUpload.config.hostname = 'example.test'
	try {
		expect(authLogin.openaiRedirectUri()).toBe('https://example.test/auth/callback')
	} finally {
		webUpload.config.hostname = originalHostname
	}
})

test('rejects a non-hostname ChatGPT callback setting', () => {
	const originalHostname = webUpload.config.hostname
	webUpload.config.hostname = 'https://example.test/auth/callback'
	try {
		expect(() => authLogin.openaiRedirectUri()).toThrow(/web.hostname/)
	} finally {
		webUpload.config.hostname = originalHostname
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
