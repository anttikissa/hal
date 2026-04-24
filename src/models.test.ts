import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, expect, test } from 'bun:test'
import { models } from './models.ts'

const origFetch = globalThis.fetch
const origStateDir = process.env.HAL_STATE_DIR

afterEach(() => {
	globalThis.fetch = origFetch
	if (origStateDir === undefined) delete process.env.HAL_STATE_DIR
	else process.env.HAL_STATE_DIR = origStateDir
	models.state.cache = null
})

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

test('refreshModels reports relevant GPT and Claude additions and context changes', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'hal-models-'))
	process.env.HAL_STATE_DIR = dir
	models.state.cache = {
		'gpt-5.4': 400_000,
		'gpt-5.5': 400_000,
		'claude-opus-4-6': 1_000_000,
	}
	Bun.write(join(dir, 'models.ason'), '')
	globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({
		openai: {
			models: {
				'gpt-5.5': { limit: { context: 1_050_000 } },
				'gpt-5.6': { limit: { context: 1_200_000 } },
			},
		},
		anthropic: {
			models: {
				'claude-opus-4-6': { limit: { context: 1_000_000 } },
				'claude-sonnet-4-7': { limit: { context: 1_000_000 } },
			},
		},
	})), { preconnect: () => {} }) as typeof fetch

	try {
		const result = await models.refreshModels()
		expect(result.fetched).toBe(true)
		expect(result.changes).toContain('gpt-5.5 context 400k → 1050k')
		expect(result.changes).toContain('new GPT model gpt-5.6 (1200k)')
		expect(result.changes).toContain('new Claude model claude-sonnet-4-7 (1000k)')
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
