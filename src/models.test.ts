import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { models } from './models.ts'
import { auth } from './auth.ts'

const origFetch = globalThis.fetch
const origStateDir = process.env.HAL_STATE_DIR

beforeEach(() => {
	auth._setStoreForTest({})
	models.state.cache = {}
})
afterEach(() => {
	globalThis.fetch = origFetch
	if (origStateDir === undefined) delete process.env.HAL_STATE_DIR
	else process.env.HAL_STATE_DIR = origStateDir
	models.state.cache = null
	auth._setStoreForTest({})
})

test('gpt and openai aliases resolve to gpt-5.5', () => {
	expect(models.resolveModel('gpt')).toBe('openai/gpt-5.5')
	expect(models.resolveModel('openai')).toBe('openai/gpt-5.5')
})


test('updated anthropic aliases avoid dated model ids', () => {
	expect(models.resolveModel('claude')).toBe('anthropic/claude-opus-4-8')
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


test('gpt-5.5 subscription route uses Codex input cap', () => {
	const dir = mkdtempSync(join(tmpdir(), 'hal-models-'))
	process.env.HAL_STATE_DIR = dir
	models.state.cache = null
	auth._setStoreForTest({ openai: { accessToken: 'tok', refreshToken: 'rt' } })
	try {
		expect(models.contextWindow('openai/gpt-5.5')).toBe(272_000)
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


test('model picker choices list newest curated versions first', () => {
	const choices = models.listModelChoices().filter((item) => item.path.join('/') === 'openai/gpt')
	const values = choices.map((item) => item.value)
	expect(values.indexOf('gpt')).toBeLessThan(values.indexOf('gpt-5.4'))
	expect(values.indexOf('gpt-5.4')).toBeLessThan(values.indexOf('codex'))
})


test('model picker and aliases use newest cached Anthropic models but keep GPT pinned', () => {
	models.state.cache = {
		'claude-opus-4-7': 1_000_000,
		'claude-opus-4-8': 1_000_000,
		'claude-sonnet-4-6': 1_000_000,
		'claude-sonnet-4-7': 1_000_000,
		'gpt-5.5': 1_050_000,
		'gpt-5.6': 1_200_000,
	}

	expect(models.resolveModel('opus')).toBe('anthropic/claude-opus-4-8')
	expect(models.resolveModel('claude')).toBe('anthropic/claude-opus-4-8')
	expect(models.resolveModel('sonnet')).toBe('anthropic/claude-sonnet-4-7')
	expect(models.resolveModel('gpt')).toBe('openai/gpt-5.5')
	expect(models.resolveModel('openai')).toBe('openai/gpt-5.5')
	expect(models.listModelChoices().find((item) => item.value === 'opus')).toMatchObject({ search: expect.stringContaining('anthropic/claude-opus-4-8') })
	expect(models.listModelChoices().find((item) => item.value === 'gpt')).toMatchObject({ search: expect.stringContaining('openai/gpt-5.5') })
	expect(models.listModelChoices().find((item) => item.value === 'gpt-5.6')).toMatchObject({ search: expect.stringContaining('openai/gpt-5.6') })
	expect(models.modelCompletionNames()).toContain('opus-4-8')
})


test('models.dev Anthropic and OpenAI entries resolve without polluting picker choices', () => {
	models.state.cache = {
		'claude-lyric-6': 1_000_000,
		'claude-opus-3-20240229': 200_000,
		'gpt-5.5-thinking': 1_000_000,
		'gpt-5.5-fast': 1_000_000,
		'o5': 200_000,
	}

	expect(models.resolveModel('claude-lyric-6')).toBe('anthropic/claude-lyric-6')
	expect(models.resolveModel('o5')).toBe('openai/o5')
	const values = models.listModelChoices().map((item) => item.value)
	expect(values).not.toContain('claude-lyric-6')
	expect(values).not.toContain('claude-opus-3-20240229')
	expect(values).not.toContain('gpt-5.5-thinking')
	expect(values).not.toContain('gpt-5.5-fast')
	expect(values).not.toContain('o5')
})


test('model completions include aliases, full ids, and bare ids', () => {
	expect(models.modelCompletionNames()).toContain('gemini')
	expect(models.modelCompletionNames()).toContain('google/gemini-3.5-flash')
	expect(models.modelCompletionNames()).toContain('gemini-3.5-flash')
	expect(models.modelCompletionNames()).toContain('sonnet-4-6')
})


test('Fable and gpt-instant aliases resolve to provider model ids', () => {
	expect(models.resolveModel('fable')).toBe('anthropic/claude-fable-5')
	expect(models.resolveModel('fable-5')).toBe('anthropic/claude-fable-5')
	expect(models.resolveModel('gpt-instant')).toBe('openai/gpt-5.5-instant')
	expect(models.resolveModel('instant')).toBe('instant')
	expect(models.resolveModel('gpt-5.5-instant')).toBe('openai/gpt-5.5-instant')
})


test('Fable and gpt-instant have picker entries, fallback context, and prices', () => {
	const dir = mkdtempSync(join(tmpdir(), 'hal-models-'))
	process.env.HAL_STATE_DIR = dir
	models.state.cache = null
	try {
		expect(models.displayModel('anthropic/claude-fable-5')).toBe('Fable 5')
		expect(models.displayModel('openai/gpt-5.5-instant')).toBe('GPT 5.5 Instant')
		expect(models.contextWindow('anthropic/claude-fable-5')).toBe(1_000_000)
		expect(models.contextWindow('openai/gpt-5.5-instant')).toBe(400_000)
		expect(models.computeCost('anthropic/claude-fable-5', { input: 1000, output: 1000, cacheRead: 0, cacheCreation: 0 })).toBe(0.06)
		expect(models.computeCost('openai/gpt-5.5-instant', { input: 1000, output: 1000, cacheRead: 0, cacheCreation: 0 })).toBe(0.035)
		expect(models.listModelChoices().find((item) => item.value === 'fable')).toMatchObject({ search: expect.stringContaining('anthropic/claude-fable-5') })
		expect(models.listModelChoices().find((item) => item.value === 'gpt-instant')).toMatchObject({ leafLabel: 'gpt-instant', search: expect.stringContaining('openai/gpt-5.5-instant') })
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})


test('aliasUpdateSuggestions detects alias-family upgrades without moving pinned GPT', () => {
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
			'claude-opus-4-8': 1_000_000,
			'claude-opus-4-9': 1_000_000,
			'claude-sonnet-4-6': 1_000_000,
			'claude-sonnet-4-7': 1_000_000,
			'google/gemini-3.5-flash': 1_000_000,
			'google/gemini-4-flash-preview': 1_000_000,
			'x-ai/grok-4.20': 2_000_000,
			'x-ai/grok-4.21': 2_000_000,
		},
	)).toEqual([
		{ aliases: ['anthropic', 'claude', 'opus'], oldModel: 'anthropic/claude-opus-4-8', newModel: 'anthropic/claude-opus-4-9' },
		{ aliases: ['sonnet'], oldModel: 'anthropic/claude-sonnet-4-6', newModel: 'anthropic/claude-sonnet-4-7' },
		{ aliases: ['gemini'], oldModel: 'google/gemini-3.5-flash', newModel: 'google/gemini-4-flash-preview' },
		{ aliases: ['grok'], oldModel: 'openrouter/x-ai/grok-4.20', newModel: 'openrouter/x-ai/grok-4.21' },
	])
})


test('aliasUpdateSuggestions treats dated Claude IDs as older than decimal versions', () => {
	expect(models.aliasUpdateSuggestions(
		{ 'claude-opus-4-8': 1_000_000 },
		{
			'anthropic/claude-opus-4-20250514': 200_000,
			'anthropic/claude-opus-4.9': 1_000_000,
		},
	)).toEqual([
		{ aliases: ['anthropic', 'claude', 'opus'], oldModel: 'anthropic/claude-opus-4-8', newModel: 'anthropic/claude-opus-4-9' },
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


test('modelChangeMessages reports new Claude families such as Fable', () => {
	expect(models.modelChangeMessages({}, {
		'claude-fable-5': 1_000_000,
	})).toContain('new Claude model claude-fable-5 (1000k)')
})


test('modelChangeMessages reports new GPT variants such as instant', () => {
	expect(models.modelChangeMessages({}, {
		'gpt-5.5-instant': 400_000,
	})).toContain('new GPT model gpt-5.5-instant (400k)')
})


test('modelChangeMessages reports new non-GPT OpenAI reasoning models', () => {
	expect(models.modelChangeMessages({}, {
		'openai/o5': 200_000,
	})).toContain('new OpenAI model openai/o5 (200k)')
})


test('modelDiscoveries reports only new Anthropic and OpenAI models once', () => {
	expect(models.modelDiscoveries(
		{ 'claude-opus-4-7': 1_000_000, 'gpt-5.5': 1_000_000 },
		{
			'claude-opus-4-7': 1_000_000,
			'claude-fable-5': 1_000_000,
			'anthropic/claude-fable-5': 1_000_000,
			'~anthropic/claude-fable-latest': 1_000_000,
			'openai/gpt-5.5-instant': 400_000,
			'gpt-5.5-instant': 400_000,
			'google/gemini-4-ultra': 1_000_000,
		},
	)).toEqual([
		{ provider: 'Anthropic', model: 'claude-fable-5', context: 1_000_000 },
		{ provider: 'OpenAI', model: 'gpt-5.5-instant', context: 400_000 },
	])
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
