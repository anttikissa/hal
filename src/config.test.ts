import { describe, test, expect } from 'bun:test'
import {
	parseModel,
	resolveModel,
	providerForModel,
	modelIdForModel,
} from './config.ts'

describe('config model helpers', () => {
	test("parseModel('codex...') resolves provider openai", () => {
		expect(parseModel('codex')).toEqual({ provider: 'openai', modelId: 'codex' })
		expect(parseModel('codex-1')).toEqual({ provider: 'openai', modelId: 'codex-1' })
		expect(parseModel('openai/gpt-5.3-codex')).toEqual({
			provider: 'openai',
			modelId: 'gpt-5.3-codex',
		})
	})

	test("resolveModel('codex') maps to alias full model", () => {
		expect(resolveModel('codex')).toBe('openai/gpt-5.3-codex')
	})

	test('providerForModel and modelIdForModel handle bare + full IDs', () => {
		expect(providerForModel('codex')).toBe('openai')
		expect(modelIdForModel('codex')).toBe('gpt-5.3-codex')

		expect(providerForModel('gpt-5.3-codex')).toBe('openai')
		expect(modelIdForModel('gpt-5.3-codex')).toBe('gpt-5.3-codex')

		expect(providerForModel('openai/gpt-5.3-codex')).toBe('openai')
		expect(modelIdForModel('openai/gpt-5.3-codex')).toBe('gpt-5.3-codex')
	})
})
