import { afterEach, beforeEach, expect, test } from 'bun:test'
import { models } from './models.ts'

beforeEach(() => {
	models.hydrate({})
})

afterEach(() => {
	models.state.cache = null
})

test('gpt and openai aliases resolve to the terra tier', () => {
	expect(models.resolveModel('gpt')).toBe('openai/gpt-5.6-terra')
	expect(models.resolveModel('openai')).toBe('openai/gpt-5.6-terra')
})


test('sol, terra, and luna aliases resolve to gpt-5.6 tier models', () => {
	expect(models.resolveModel('sol')).toBe('openai/gpt-5.6-sol')
	expect(models.resolveModel('terra')).toBe('openai/gpt-5.6-terra')
	expect(models.resolveModel('luna')).toBe('openai/gpt-5.6-luna')
})


test('Astra resolves, displays, prices, and appears in the OpenAI picker', () => {
	expect(models.resolveModel('astra')).toBe('openai/gpt-6-astra')
	expect(models.resolveModel('gpt-6-astra')).toBe('openai/gpt-6-astra')
	expect(models.displayModel('openai/gpt-6-astra')).toBe('GPT 6 Astra')
	expect(models.reasoningEffort('openai/gpt-6-astra')).toBe('high')
	expect(models.computeCost('openai/gpt-6-astra', { input: 1000, output: 1000, cacheRead: 0, cacheCreation: 0 })).toBe(0.06)
	expect(models.listModelChoices().find((item) => item.value === 'astra')).toMatchObject({
		fullId: 'openai/gpt-6-astra',
		path: ['openai', 'gpt'],
		leafLabel: '6-astra',
	})
})


test('intro alias resolves to the local synthetic model and appears in the picker', () => {
	expect(models.resolveModel('intro')).toBe('hal/intro')
	expect(models.modelCompletionNames()).toContain('hal/intro')
	expect(models.listModelChoices().find((item) => item.value === 'intro')).toMatchObject({
		fullId: 'hal/intro',
		path: ['hal'],
	})
})


test('hydrated tier aliases track newer generations but ignore pro variants', () => {
	models.hydrate({
		'gpt-5.6-sol': 1_050_000,
		'gpt-5.6-terra': 1_050_000,
		'gpt-5.7-terra': 1_050_000,
		'gpt-5.7-terra-pro': 1_050_000,
		'gpt-5.8-sol-pro': 1_050_000,
	})
	expect(models.resolveModel('terra')).toBe('openai/gpt-5.7-terra')
	expect(models.resolveModel('gpt')).toBe('openai/gpt-5.7-terra')
	expect(models.resolveModel('sol')).toBe('openai/gpt-5.6-sol')
})


test('updated anthropic aliases avoid dated model ids', () => {
	expect(models.resolveModel('claude')).toBe('anthropic/claude-opus-5')
	expect(models.resolveModel('sonnet')).toBe('anthropic/claude-sonnet-5')
	expect(models.resolveModel('haiku')).toBe('anthropic/claude-haiku-4-5')
})


test('default model resolves to gpt-5.6-terra', () => {
	const origDefault = models.config.default
	try {
		models.config.default = 'gpt'
		expect(models.defaultModel()).toBe('openai/gpt-5.6-terra')
	} finally {
		models.config.default = origDefault
	}
})

test('model picker lists updated frontier aliases', () => {
	expect(models.listModelChoices().find((item) => item.value === 'gpt')).toMatchObject({
		value: 'gpt',
		label: expect.stringContaining('GPT 5.6 Terra'),
		search: expect.stringContaining('openai/gpt-5.6-terra'),
	})
	expect(models.listModelChoices().find((item) => item.value === 'sol')).toMatchObject({
		value: 'sol',
		search: expect.stringContaining('openai/gpt-5.6-sol'),
	})
	expect(models.listModelChoices().find((item) => item.value === 'luna')).toMatchObject({
		value: 'luna',
		search: expect.stringContaining('openai/gpt-5.6-luna'),
	})
	expect(models.listModelChoices().find((item) => item.value === 'sonnet')).toMatchObject({
		value: 'sonnet',
		search: expect.stringContaining('anthropic/claude-sonnet-5'),
	})
	expect(models.listModelChoices().find((item) => item.value === 'gemini')).toMatchObject({
		value: 'gemini',
		search: expect.stringContaining('google/gemini-3.8-flash'),
	})
	expect(models.listModelChoices().find((item) => item.value === 'gpt-5.6')).toMatchObject({ search: expect.stringContaining('openai/gpt-5.6') })
	expect(models.listModelChoices().find((item) => item.value === 'gemini-3.5-flash-lite')).toMatchObject({ search: expect.stringContaining('google/gemini-3.5-flash-lite') })
	expect(models.listModelChoices().find((item) => item.value === 'grok')).toMatchObject({
		value: 'grok',
		search: expect.stringContaining('openrouter/x-ai/grok-4.6'),
	})
})
test('model picker lists Grok 4.5 and 4.6 and ranks 4.6 above 4.20', () => {
	models.hydrate({}, ['x-ai/grok-4.6', 'x-ai/grok-4.5', 'x-ai/grok-4.20'])
	const grok = models.listModelChoices().filter((item) => item.path.join('/') === 'openrouter/x-ai')
	const values = grok.map((item) => item.value)
	expect(values).toContain('grok')
	expect(values).toContain('x-ai/grok-4.5')
	expect(values).toContain('x-ai/grok-4.20')
	expect(grok.find((item) => item.value === 'grok')).toMatchObject({
		fullId: 'openrouter/x-ai/grok-4.6',
		search: expect.stringContaining('openrouter/x-ai/grok-4.6'),
	})
	expect(models.resolveModel('grok')).toBe('openrouter/x-ai/grok-4.6')
	expect(models.resolveModel('grok-4.5')).toBe('openrouter/x-ai/grok-4.5')
})
test('model picker lists new open-weight OpenRouter aliases', () => {
	expect(models.resolveModel('deepseek')).toBe('openrouter/deepseek/deepseek-v3.2')
	expect(models.resolveModel('deepseek-4')).toBe('openrouter/deepseek/deepseek-v4-pro')
	expect(models.resolveModel('qwen')).toBe('openrouter/qwen/qwen3.8-max')
	expect(models.resolveModel('qwen-coder')).toBe('openrouter/qwen/qwen3-coder')
	expect(models.resolveModel('kimi')).toBe('openrouter/moonshotai/kimi-k3')
	expect(models.resolveModel('glm')).toBe('openrouter/z-ai/glm-5.2')
	expect(models.resolveModel('minimax')).toBe('openrouter/minimax/minimax-m3')
	expect(models.resolveModel('mistral')).toBe('openrouter/mistralai/mistral-large-2512')
	const values = models.listModelChoices().map((item) => item.value)
	for (const value of ['deepseek', 'deepseek-4', 'qwen', 'qwen-coder', 'kimi', 'glm', 'minimax', 'mistral', 'llama']) {
		expect(values).toContain(value)
	}
})

test('any openrouter model from models.dev resolves, completes, and is listed by vendor', () => {
	// models.dev resells Anthropic/OpenAI/Google models through OpenRouter too.
	models.hydrate({}, ['qwen/qwen3.8-max', 'stealth/ox-alpha', 'anthropic/claude-opus-5', 'google/gemini-3.7-flash'])

	expect(models.resolveModel('qwen/qwen3.8-max')).toBe('openrouter/qwen/qwen3.8-max')
	expect(models.resolveModel('stealth/ox-alpha')).toBe('openrouter/stealth/ox-alpha')
	// Already-prefixed ids, direct-provider ids, and unknown ids are left alone.
	expect(models.resolveModel('openrouter/qwen/qwen3.8-max')).toBe('openrouter/qwen/qwen3.8-max')
	expect(models.resolveModel('anthropic/claude-opus-5')).toBe('anthropic/claude-opus-5')
	expect(models.resolveModel('google/gemini-3.7-flash')).toBe('google/gemini-3.7-flash')
	expect(models.resolveModel('nobody/nothing')).toBe('nobody/nothing')

	expect(models.modelCompletionNames()).toContain('stealth/ox-alpha')
	expect(models.modelCompletionNames()).toContain('openrouter/stealth/ox-alpha')

	expect(models.listModelChoices().find((item) => item.value === 'stealth/ox-alpha')).toMatchObject({
		fullId: 'openrouter/stealth/ox-alpha',
		path: ['openrouter', 'stealth'],
		leafLabel: 'ox-alpha',
	})
})

test('a bare openrouter model name resolves to its vendor id', () => {
	models.hydrate({}, ['z-ai/glm-5.3', 'z-ai/glm-5.2', 'stealth/ox-alpha', 'qwen/qwen3.8-max'])

	expect(models.resolveModel('glm-5.3')).toBe('openrouter/z-ai/glm-5.3')
	expect(models.resolveModel('ox-alpha')).toBe('openrouter/stealth/ox-alpha')
	// Catalog aliases still win over a bare models.dev name.
	expect(models.resolveModel('glm')).toBe('openrouter/z-ai/glm-5.2')
	// A name no vendor offers stays untouched, so the caller can report it as missing.
	expect(models.resolveModel('glm-9.9')).toBe('glm-9.9')

	expect(models.modelCompletionNames()).toContain('glm-5.3')
})

test('an aliased openrouter model is listed once, under its alias', () => {
	models.hydrate({}, ['qwen/qwen3.8-max', 'qwen/qwen3-max', 'qwen/qwen3-coder'])
	const qwen = models.listModelChoices().filter((item) => item.path.join('/') === 'openrouter/qwen')
	const values = qwen.map((item) => item.value)
	expect(values).toContain('qwen')
	expect(values).not.toContain('qwen/qwen3.8-max')
	expect(values).toContain('qwen/qwen3-max')
	expect(qwen.find((item) => item.value === 'qwen')).toMatchObject({ fullId: 'openrouter/qwen/qwen3.8-max' })
	expect(qwen.find((item) => item.value === 'qwen-coder')).toMatchObject({ fullId: 'openrouter/qwen/qwen3-coder' })
})

test('gemini-pro alias stays on the gemini pro line when other tracks have newer models', () => {
	models.hydrate({
		'google/gemini-3.1-pro-preview': 1_000_000,
		'google/gemini-3.3-pro': 1_000_000,
		'x-ai/grok-4.7': 2_000_000,
		'qwen/qwen3.8-max': 1_000_000,
	})
	expect(models.resolveModel('gemini-pro')).toBe('google/gemini-3.3-pro')
})


test('catalog openrouter models stay listed without discovery data', () => {
	expect(models.resolveModel('qwen')).toBe('openrouter/qwen/qwen3.8-max')
	const values = models.listModelChoices().map((item) => item.value)
	expect(values).toContain('qwen')
})






test('model picker choices list newest curated versions first', () => {
	const choices = models.listModelChoices().filter((item) => item.path.join('/') === 'openai/gpt')
	const values = choices.map((item) => item.value)
	expect(values.indexOf('gpt')).toBeLessThan(values.indexOf('gpt-5.4'))
	expect(values.indexOf('gpt-5.4')).toBeLessThan(values.indexOf('codex'))
})


test('model picker and aliases use the newest Anthropic model from catalog or cache; GPT falls back to catalog terra', () => {
	models.state.cache = {
		'claude-opus-4-7': 1_000_000,
		'claude-opus-4-8': 1_000_000,
		'claude-sonnet-4-6': 1_000_000,
		'claude-sonnet-4-7': 1_000_000,
		'gpt-5.5': 1_050_000,
		'gpt-5.6': 1_200_000,
	}

	expect(models.resolveModel('opus')).toBe('anthropic/claude-opus-5')
	expect(models.resolveModel('claude')).toBe('anthropic/claude-opus-5')
	expect(models.resolveModel('sonnet')).toBe('anthropic/claude-sonnet-5')
	// No tier models in cache: the gpt alias falls back to the catalog terra entry.
	expect(models.resolveModel('gpt')).toBe('openai/gpt-5.6-terra')
	expect(models.resolveModel('openai')).toBe('openai/gpt-5.6-terra')
	expect(models.listModelChoices().find((item) => item.value === 'opus')).toMatchObject({ search: expect.stringContaining('anthropic/claude-opus-5') })
	expect(models.listModelChoices().find((item) => item.value === 'sonnet')).toMatchObject({ search: expect.stringContaining('anthropic/claude-sonnet-5') })
	expect(models.listModelChoices().find((item) => item.value === 'gpt')).toMatchObject({ search: expect.stringContaining('openai/gpt-5.6-terra') })
	expect(models.listModelChoices().find((item) => item.value === 'gpt-5.6')).toMatchObject({ search: expect.stringContaining('openai/gpt-5.6') })
	expect(models.modelCompletionNames()).toContain('opus-5')
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
	expect(models.modelCompletionNames()).toContain('google/gemini-3.8-flash')
	expect(models.modelCompletionNames()).toContain('gemini-3.8-flash')
	expect(models.modelCompletionNames()).toContain('sonnet-5')
})


test('Fable and gpt-instant aliases resolve to provider model ids', () => {
	expect(models.resolveModel('fable')).toBe('anthropic/claude-fable-5-1')
	expect(models.resolveModel('fable-5')).toBe('anthropic/claude-fable-5')
	expect(models.resolveModel('fable-5-1')).toBe('anthropic/claude-fable-5-1')
	expect(models.resolveModel('gpt-instant')).toBe('openai/gpt-5.5-instant')
	expect(models.resolveModel('instant')).toBe('instant')
	expect(models.resolveModel('gpt-5.5-instant')).toBe('openai/gpt-5.5-instant')
})
test('aliasUpdateSuggestions detects alias-family upgrades without moving pinned GPT', () => {
	expect(models.aliasUpdateSuggestions(
		{
			'gpt-5.5': 1_050_000,
			'claude-opus-4-7': 1_000_000,
			'claude-sonnet-5': 1_000_000,
			'google/gemini-3.5-flash': 1_000_000,
			'google/gemini-3-flash-preview': 1_000_000,
			'x-ai/grok-4.6': 2_000_000,
		},
		{
			'gpt-5.5': 1_050_000,
			'gpt-5.6': 1_050_000,
			'claude-opus-5': 1_000_000,
			'claude-opus-5-1': 1_000_000,
			'claude-sonnet-5': 1_000_000,
			'claude-sonnet-5-1': 1_000_000,
			'google/gemini-3.5-flash': 1_000_000,
			'google/gemini-4-flash-preview': 1_000_000,
			'x-ai/grok-4.6': 2_000_000,
			'x-ai/grok-4.7': 2_000_000,
		},
	)).toEqual([
		{ aliases: ['anthropic', 'claude', 'opus'], oldModel: 'anthropic/claude-opus-5', newModel: 'anthropic/claude-opus-5-1' },
		{ aliases: ['sonnet'], oldModel: 'anthropic/claude-sonnet-5', newModel: 'anthropic/claude-sonnet-5-1' },
		{ aliases: ['gemini'], oldModel: 'google/gemini-3.8-flash', newModel: 'google/gemini-4-flash-preview' },
		{ aliases: ['grok'], oldModel: 'openrouter/x-ai/grok-4.6', newModel: 'openrouter/x-ai/grok-4.7' },
	])
})


test('aliasUpdateSuggestions treats dated Claude IDs as older than decimal versions', () => {
	expect(models.aliasUpdateSuggestions(
		{ 'claude-opus-5': 1_000_000 },
		{
			'anthropic/claude-opus-5-20250514': 200_000,
			'anthropic/claude-opus-5.1': 1_000_000,
		},
	)).toEqual([
		{ aliases: ['anthropic', 'claude', 'opus'], oldModel: 'anthropic/claude-opus-5', newModel: 'anthropic/claude-opus-5-1' },
	])
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


test('modelDiscoveries reports new direct-provider models once', () => {
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
		{ provider: 'Google', model: 'gemini-4-ultra', context: 1_000_000 },
		{ provider: 'OpenAI', model: 'gpt-5.5-instant', context: 400_000 }
	])
})
