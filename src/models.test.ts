import { expect, test } from 'bun:test'
import { models } from './models.ts'

test('gpt alias resolves to gpt-5.5', () => {
	expect(models.resolveModel('gpt')).toBe('openai/gpt-5.5')
})

test('default model resolves to gpt-5.5', () => {
	const origDefault = models.config.default
	try {
		models.config.default = 'gpt'
		expect(models.defaultModel()).toBe('openai/gpt-5.5')
	} finally {
		models.config.default = origDefault
	}
})

test('gpt-5.5 gets high reasoning effort and fallback context window', () => {
	expect(models.reasoningEffort('openai/gpt-5.5')).toBe('high')
	expect(models.contextWindow('openai/gpt-5.5')).toBe(1_050_000)
})

test('model picker lists gpt-5.5', () => {
	const choice = models.listModelChoices().find((item) => item.value === 'gpt')
	expect(choice).toMatchObject({
		value: 'gpt',
		label: expect.stringContaining('GPT 5.5'),
		search: expect.stringContaining('openai/gpt-5.5'),
	})
})
