import { beforeEach, expect, test } from 'bun:test'
import { accountRotation, type RotationCandidate } from './account-rotation.ts'

function candidate(key: string): RotationCandidate {
	return { _key: key }
}

beforeEach(() => {
	accountRotation.config.strategy = 'leastUsed'
	accountRotation.io.currentKey = () => ''
	accountRotation.io.usageWindows = () => []
})

test('leastUsed picks the account with the lowest longest-window usage', () => {
	accountRotation.io.usageWindows = (_provider, key) => ({
		a: [{ durationMinutes: 300, usedPercent: 3 }, { durationMinutes: 10_080, usedPercent: 61 }],
		b: [{ durationMinutes: 300, usedPercent: 90 }, { durationMinutes: 10_080, usedPercent: 24 }],
		c: [{ durationMinutes: 300, usedPercent: 0 }, { durationMinutes: 10_080, usedPercent: 45 }],
	}[key] ?? [])

	expect(accountRotation.pick('openai', [candidate('a'), candidate('b'), candidate('c')])?._key).toBe('b')
})

test('leastUsed keeps using the current account until it becomes unavailable', () => {
	accountRotation.io.currentKey = () => 'a'
	accountRotation.io.usageWindows = (_provider, key) => [{ durationMinutes: 10_080, usedPercent: key === 'a' ? 90 : 10 }]

	expect(accountRotation.pick('openai', [candidate('a'), candidate('b')])?._key).toBe('a')
})

test('leastUsed uses the most constrained quota when longest windows tie', () => {
	accountRotation.io.usageWindows = (_provider, key) => ({
		a: [{ durationMinutes: 10_080, usedPercent: 20 }, { durationMinutes: 10_080, usedPercent: 95 }],
		b: [{ durationMinutes: 10_080, usedPercent: 40 }, { durationMinutes: 10_080, usedPercent: 50 }],
	}[key] ?? [])

	expect(accountRotation.pick('anthropic', [candidate('a'), candidate('b')])?._key).toBe('b')
})

test('leastUsed keeps ordered selection when quota data is incomplete', () => {
	accountRotation.io.usageWindows = (_provider, key) => key === 'b'
		? [{ durationMinutes: 10_080, usedPercent: 10 }]
		: []

	expect(accountRotation.pick('openai', [candidate('a'), candidate('b')])?._key).toBe('a')
})

test('next keeps ordered selection regardless of quota usage', () => {
	accountRotation.config.strategy = 'next'
	accountRotation.io.usageWindows = (_provider, key) => [{ durationMinutes: 10_080, usedPercent: key === 'a' ? 90 : 10 }]

	expect(accountRotation.pick('openai', [candidate('a'), candidate('b')])?._key).toBe('a')
})
