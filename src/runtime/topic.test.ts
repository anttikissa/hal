import { describe, test, expect } from 'bun:test'
import { shouldSkipAutoTopic } from './topic.ts'

describe('shouldSkipAutoTopic', () => {
	test('rejects known generic topics', () => {
		expect(shouldSkipAutoTopic('No response.')).toBe(true)
		expect(shouldSkipAutoTopic('Greeting introduction')).toBe(true)
		expect(shouldSkipAutoTopic('Initial greeting exchange')).toBe(true)
	})

	test('rejects greeting-like generic topic for greeting prompts', () => {
		expect(shouldSkipAutoTopic('Greeting flow', 'hello')).toBe(true)
		expect(shouldSkipAutoTopic('Greeting flow', 'hey there')).toBe(true)
	})

	test('accepts specific technical topics', () => {
		expect(shouldSkipAutoTopic('Fix topic persistence after restart')).toBe(false)
		expect(shouldSkipAutoTopic('Restore conversation replay bug')).toBe(false)
	})
})
