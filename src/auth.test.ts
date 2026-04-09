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
