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

test('gpt and openai aliases resolve to gpt-5.5', () => {
	expect(models.resolveModel('gpt')).toBe('openai/gpt-5.5')
	expect(models.resolveModel('openai')).toBe('openai/gpt-5.5')
})


test('updated anthropic aliases avoid dated model ids', () => {
	expect(models.resolveModel('claude')).toBe('anthropic/claude-opus-4-7')
	expect(models.resolveModel('sonnet')).toBe('anthropic/claude-sonnet-4-6')
	expect(models.resolveModel('haiku')).toBe('anthropic/claude-haiku-4-5')
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
	const dir = mkdtempSync(join(tmpdir(), 'hal-models-'))
	process.env.HAL_STATE_DIR = dir
	models.state.cache = null
	try {
		expect(models.reasoningEffort('openai/gpt-5.5')).toBe('high')
		expect(models.contextWindow('openai/gpt-5.5')).toBe(1_050_000)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})


test('model picker lists updated frontier aliases', () => {
	expect(models.listModelChoices().find((item) => item.value === 'gpt')).toMatchObject({
		value: 'gpt',
		label: expect.stringContaining('GPT 5.5'),
		search: expect.stringContaining('openai/gpt-5.5'),
	})
	expect(models.listModelChoices().find((item) => item.value === 'sonnet')).toMatchObject({
		value: 'sonnet',
		search: expect.stringContaining('anthropic/claude-sonnet-4-6'),
	})
	expect(models.listModelChoices().find((item) => item.value === 'gemini')).toMatchObject({
		value: 'gemini',
		search: expect.stringContaining('google/gemini-3.5-flash'),
	})
	expect(models.listModelChoices().find((item) => item.value === 'grok')).toMatchObject({
		value: 'grok',
		search: expect.stringContaining('openrouter/x-ai/grok-4.20'),
	})
})


test('model completions include aliases, full ids, and bare ids', () => {
	expect(models.modelCompletionNames()).toContain('gemini')
	expect(models.modelCompletionNames()).toContain('google/gemini-3.5-flash')
	expect(models.modelCompletionNames()).toContain('gemini-3.5-flash')
	expect(models.modelCompletionNames()).toContain('sonnet-4-6')
})


test('aliasUpdateSuggestions detects multiple alias-family upgrades', () => {
	expect(models.aliasUpdateSuggestions(
		{
			'gpt-5.5': 1_050_000,
			'claude-opus-4-7': 1_000_000,
			'claude-sonnet-4-6': 1_000_000,
			'google/gemini-3.5-flash': 1_000_000,
			'google/gemini-3-flash-preview': 1_000_000,
			'x-ai/grok-4.20': 2_000_000,
		},
		{
			'gpt-5.5': 1_050_000,
			'gpt-5.6': 1_050_000,
			'claude-opus-4-7': 1_000_000,
			'claude-opus-4-8': 1_000_000,
			'claude-sonnet-4-6': 1_000_000,
			'claude-sonnet-4-7': 1_000_000,
			'google/gemini-3.5-flash': 1_000_000,
			'google/gemini-4-flash-preview': 1_000_000,
			'x-ai/grok-4.20': 2_000_000,
			'x-ai/grok-4.21': 2_000_000,
		},
	)).toEqual([
		{ aliases: ['anthropic', 'claude', 'opus'], oldModel: 'anthropic/claude-opus-4-7', newModel: 'anthropic/claude-opus-4-8' },
		{ aliases: ['sonnet'], oldModel: 'anthropic/claude-sonnet-4-6', newModel: 'anthropic/claude-sonnet-4-7' },
		{ aliases: ['openai', 'gpt'], oldModel: 'openai/gpt-5.5', newModel: 'openai/gpt-5.6' },
		{ aliases: ['gemini'], oldModel: 'google/gemini-3.5-flash', newModel: 'google/gemini-4-flash-preview' },
		{ aliases: ['grok'], oldModel: 'openrouter/x-ai/grok-4.20', newModel: 'openrouter/x-ai/grok-4.21' },
	])
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


test('refreshModels treats missing cache as initial fetch without change spam', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'hal-models-'))
	process.env.HAL_STATE_DIR = dir
	globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({
		openai: {
			models: {
				'gpt-5.5': { limit: { context: 1_050_000 } },
				'gpt-5.6': { limit: { context: 1_200_000 } },
			},
		},
		anthropic: {
			models: {
				'claude-sonnet-4-7': { limit: { context: 1_000_000 } },
			},
		},
	})), { preconnect: () => {} }) as typeof fetch

	try {
		const result = await models.refreshModels()
		expect(result.fetched).toBe(true)
		expect(result.hadCache).toBe(false)
		expect(result.modelCount).toBe(3)
		expect(result.changes).toEqual([])
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
