import { beforeEach, describe, expect, test } from 'bun:test'
import { auth } from './auth.ts'
import { authLogin } from './auth-login.ts'

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
