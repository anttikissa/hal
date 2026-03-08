import { test, expect, beforeEach, afterEach } from 'bun:test'
import { contextWindowForModel, estimateTokens, saveCalibration, isCalibrated, messageBytes } from './context.ts'

test('contextWindowForModel returns known sizes', () => {
	expect(contextWindowForModel('claude-opus-4-6')).toBe(200_000)
	expect(contextWindowForModel('claude-sonnet-4-6')).toBe(200_000)
})

test('contextWindowForModel returns default for unknown models', () => {
	expect(contextWindowForModel('gpt-5')).toBe(200_000)
})

test('estimateTokens uses default 4 bytes/token before calibration', () => {
	expect(estimateTokens(400, 'test-uncalibrated-model')).toBe(100)
	expect(estimateTokens(401, 'test-uncalibrated-model')).toBe(101)
})

test('messageBytes counts string content', () => {
	expect(messageBytes({ content: 'hello' })).toBe(5)
})

test('messageBytes counts array content', () => {
	const msg = {
		content: [
			{ type: 'text', text: 'hello world' },
			{ type: 'tool_result', content: 'result text' },
		]
	}
	expect(messageBytes(msg)).toBe(22)
})

test('messageBytes returns 0 for unknown format', () => {
	expect(messageBytes({})).toBe(0)
})

test('saveCalibration + estimateTokens uses calibrated ratio', () => {
	// 1000 bytes mapped to 200 tokens → 5 bytes/token
	saveCalibration('test-cal-model', 1000, 200)
	expect(isCalibrated('test-cal-model')).toBe(true)
	expect(estimateTokens(500, 'test-cal-model')).toBe(100)
	expect(estimateTokens(501, 'test-cal-model')).toBe(101)
})
