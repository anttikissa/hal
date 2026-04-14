// Tests for token rotation in auth module.
//
// Covers: single account backward compat, multi-account rotation,
// cooldown tracking, and the "all accounts exhausted" case.

import { describe, test, expect, beforeEach } from 'bun:test'
import { auth, type Credential } from './auth.ts'

// ── Helpers ──
// We inject a fake store via auth._setStoreForTest so we don't touch
// real auth.ason or env vars.

function fakeAccount(email: string, token: string) {
	return { accessToken: token, refreshToken: 'rt_fake', expires: Date.now() + 3600_000, email }
}

describe('auth.getCredential — single account (backward compat)', () => {
	beforeEach(() => {
		auth._resetCooldowns()
	})

	test('single object entry works', () => {
		auth._setStoreForTest({
			openai: { accessToken: 'tok_single', refreshToken: 'rt_1', expires: Date.now() + 3600_000 },
		})
		const cred = auth.getCredential('openai')
		expect(cred).toBeDefined()
		expect(cred!.value).toBe('tok_single')
		expect(cred!.type).toBe('token')
	})

	test('single object entry with email returns email', () => {
		auth._setStoreForTest({
			openai: { accessToken: 'tok_1', email: 'a@test.com' },
		})
		const cred = auth.getCredential('openai')
		expect(cred!.email).toBe('a@test.com')
	})
})

describe('auth.getCredential — multi-account rotation', () => {
	beforeEach(() => {
		auth._resetCooldowns()
		auth._setStoreForTest({
			openai: [
				fakeAccount('a@test.com', 'tok_a'),
				fakeAccount('b@test.com', 'tok_b'),
				fakeAccount('c@test.com', 'tok_c'),
			],
		})
	})

	test('returns first account when none on cooldown', () => {
		const cred = auth.getCredential('openai')
		expect(cred!.value).toBe('tok_a')
		expect(cred!.email).toBe('a@test.com')
	})

	test('includes account position for multi-account rotation', () => {
		const cred = auth.getCredential('openai')
		expect(cred!.index).toBe(0)
		expect(cred!.total).toBe(3)
	})

	test('skips account on cooldown', () => {
		const cred1 = auth.getCredential('openai')
		auth.markCooldown(cred1!, 60_000)
		const cred2 = auth.getCredential('openai')
		expect(cred2!.value).toBe('tok_b')
		expect(cred2!.email).toBe('b@test.com')
	})

	test('skips multiple cooldown accounts', () => {
		const c1 = auth.getCredential('openai')
		auth.markCooldown(c1!, 60_000)
		const c2 = auth.getCredential('openai')
		auth.markCooldown(c2!, 60_000)
		const c3 = auth.getCredential('openai')
		expect(c3!.value).toBe('tok_c')
	})

	test('all accounts on cooldown returns soonest-expiring one', () => {
		const c1 = auth.getCredential('openai')
		auth.markCooldown(c1!, 60_000)
		const c2 = auth.getCredential('openai')
		auth.markCooldown(c2!, 30_000)  // shortest cooldown
		const c3 = auth.getCredential('openai')
		auth.markCooldown(c3!, 90_000)
		const c4 = auth.getCredential('openai')
		// Should get b (30s cooldown, soonest)
		expect(c4!.value).toBe('tok_b')
	})
})

describe('auth.hasAvailableCredential', () => {
	beforeEach(() => {
		auth._resetCooldowns()
		auth._setStoreForTest({
			openai: [
				fakeAccount('a@test.com', 'tok_a'),
				fakeAccount('b@test.com', 'tok_b'),
			],
		})
	})

	test('true when no cooldowns', () => {
		expect(auth.hasAvailableCredential('openai')).toBe(true)
	})

	test('true when some but not all on cooldown', () => {
		const c1 = auth.getCredential('openai')
		auth.markCooldown(c1!, 60_000)
		expect(auth.hasAvailableCredential('openai')).toBe(true)
	})

	test('false when all on cooldown', () => {
		const c1 = auth.getCredential('openai')
		auth.markCooldown(c1!, 60_000)
		const c2 = auth.getCredential('openai')
		auth.markCooldown(c2!, 60_000)
		expect(auth.hasAvailableCredential('openai')).toBe(false)
	})
})

describe('auth.markCooldown', () => {
	beforeEach(() => {
		auth._resetCooldowns()
	})

	test('expired cooldown is ignored — account becomes available again', () => {
		auth._setStoreForTest({
			openai: [
				fakeAccount('a@test.com', 'tok_a'),
				fakeAccount('b@test.com', 'tok_b'),
			],
		})
		const c1 = auth.getCredential('openai')
		// Mark cooldown for 1ms (effectively expired immediately)
		auth.markCooldown(c1!, -1)
		const c2 = auth.getCredential('openai')
		// Should return a again since cooldown expired
		expect(c2!.value).toBe('tok_a')
	})

	test('does nothing for credentials without _key', () => {
		// A plain credential (e.g. from env var) should not crash
		const plain: Credential = { value: 'sk-test', type: 'api-key' }
		// Should not throw
		auth.markCooldown(plain, 60_000)
	})
})

describe('auth.allOnCooldownMessage', () => {
	beforeEach(() => {
		auth._resetCooldowns()
	})

	test('returns null when accounts available', () => {
		auth._setStoreForTest({
			openai: [fakeAccount('a@test.com', 'tok_a')],
		})
		expect(auth.allOnCooldownMessage('openai')).toBeNull()
	})

	test('returns message with emails when all accounts exhausted', () => {
		auth._setStoreForTest({
			openai: [
				fakeAccount('a@test.com', 'tok_a'),
				fakeAccount('b@test.com', 'tok_b'),
			],
		})
		const c1 = auth.getCredential('openai')
		auth.markCooldown(c1!, 60_000)
		const c2 = auth.getCredential('openai')
		auth.markCooldown(c2!, 60_000)
		const msg = auth.allOnCooldownMessage('openai')
		expect(msg).toContain('a@test.com')
		expect(msg).toContain('b@test.com')
		expect(msg).toContain('All')
	})
})

describe('cooldown persistence across restarts', () => {
	beforeEach(() => {
		auth._resetCooldowns()
	})

	test('cooldowns survive in-memory reset (simulating restart)', () => {
		auth._setStoreForTest({
			openai: [
				fakeAccount('a@test.com', 'tok_a'),
				fakeAccount('b@test.com', 'tok_b'),
			],
		})
		// Put account 0 on cooldown
		const c1 = auth.getCredential('openai')
		expect(c1!.email).toBe('a@test.com')
		auth.markCooldown(c1!, 60_000) // writes to disk

		// Simulate restart: clear in-memory state, re-read from disk
		auth._resetCooldowns()
		// Force reload from disk on next access
		auth._invalidateCooldownCache()

		// After "restart", getCredential should skip the cooled-down account
		const after = auth.getCredential('openai')
		expect(after!.email).toBe('b@test.com')
	})
})


describe('auth.ensureFresh — anthropic multi-account refresh', () => {
	beforeEach(() => {
		auth._resetCooldowns()
	})

	test('refreshes each expired anthropic account in an array', async () => {
		const origFetch = globalThis.fetch
		const seenRefreshTokens: string[] = []
		globalThis.fetch = Object.assign(async (_input: any, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? '{}'))
			seenRefreshTokens.push(body.refresh_token)
			return new Response(JSON.stringify({
				access_token: `fresh_${body.refresh_token}`,
				refresh_token: `next_${body.refresh_token}`,
				expires_in: 3600,
			}), { status: 200 }) as any
		}, { preconnect: () => {} }) as typeof fetch

		try {
			auth._setStoreForTest({
				anthropic: [
					{ accessToken: 'old_a', refreshToken: 'rt_a', expires: 0, email: 'a@test.com' },
					{ accessToken: 'old_b', refreshToken: 'rt_b', expires: 0, email: 'b@test.com' },
				],
			})

			await auth.ensureFresh('anthropic')

			expect(seenRefreshTokens).toEqual(['rt_a', 'rt_b'])
			const creds = auth.listCredentials('anthropic')
			expect(creds.map((cred) => cred.value)).toEqual(['fresh_rt_a', 'fresh_rt_b'])
			expect(creds.map((cred) => cred.email)).toEqual(['a@test.com', 'b@test.com'])
		} finally {
			globalThis.fetch = origFetch
		}
	})
})
