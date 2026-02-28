import { describe, test, expect } from 'bun:test'
import { contextWindowForModel, shouldWarn } from './context.ts'

describe('contextWindowForModel', () => {
	test('returns 200k for claude models', () => {
		expect(contextWindowForModel('claude-opus-4-6')).toBe(200_000)
		expect(contextWindowForModel('claude-sonnet-4-20250514')).toBe(200_000)
	})

	test('returns 400k for gpt-5.x models', () => {
		expect(contextWindowForModel('gpt-5.3-codex')).toBe(400_000)
		expect(contextWindowForModel('gpt-5.2')).toBe(400_000)
		expect(contextWindowForModel('gpt-5.1-mini')).toBe(400_000)
	})

	test('returns 128k for gpt-4o', () => {
		expect(contextWindowForModel('gpt-4o')).toBe(128_000)
		expect(contextWindowForModel('gpt-4o-mini')).toBe(128_000)
	})

	test('returns 200k for o-series models', () => {
		expect(contextWindowForModel('o3')).toBe(200_000)
		expect(contextWindowForModel('o3-mini')).toBe(200_000)
		expect(contextWindowForModel('o1')).toBe(200_000)
	})

	test('returns default 200k for unknown models', () => {
		expect(contextWindowForModel('some-unknown-model')).toBe(200_000)
	})
})

describe('shouldWarn', () => {
	test('warns when context > 66%', () => {
		expect(shouldWarn({ input_tokens: 140_000 }, 200_000)).toBe(true)
		expect(shouldWarn({ input_tokens: 100_000 }, 200_000)).toBe(false)
	})

	test('uses correct context window for calculation', () => {
		// 270k is >66% of 400k but not >66% if we mistakenly used 200k
		expect(shouldWarn({ input_tokens: 270_000 }, 400_000)).toBe(true)
		// 130k is <66% of 200k
		expect(shouldWarn({ input_tokens: 130_000 }, 200_000)).toBe(false)
	})
})
