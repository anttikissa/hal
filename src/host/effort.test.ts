import { expect, test } from 'bun:test'
import { effort } from './effort.ts'
import { auth } from './auth.ts'
import { useHost } from './host-fixture.test.ts'
import { models } from './models.ts'
import { provider } from './provider.ts'
import { anthropic } from './anthropic.ts'
import { openai } from './openai.ts'
import { openaiCompat } from './openai-compat.ts'

useHost()

test('qualifiers preserve exact colon ids, parse only final effort and reject unknown/unsupported qualifiers', () => {
	let known = models.known
	let envKey = auth.envKey
	auth.envKey = () => 'test-only'
	models.known = () => ['ollama/qwen3:8b', 'openrouter/vendor/model:free', 'openai/gpt-6-sol', 'openrouter/vendor/model:high']
	try {
		expect(models.selection('ollama/qwen3:8b')).toEqual({ id: 'ollama/qwen3:8b' })
		expect(models.selection('openrouter/vendor/model:high')).toEqual({ id: 'openrouter/vendor/model:high' })
		expect(models.selection('openrouter/vendor/model:free:default')).toEqual({ id: 'openrouter/vendor/model:free' })
		expect(models.selection('openai/gpt-6-sol:max')).toEqual({ id: 'openai/gpt-6-sol', effort: 'max' })
		expect(models.selection('gpt:high')).toEqual({ id: 'openai/gpt-6.1-sol', effort: 'high' })
		expect(() => models.selection('opus:none')).toThrow('unsupported effort')
		expect(() => models.selection('openai/gpt-6-sol:banana')).toThrow('unknown effort')
		expect(() => models.selection('openai/gpt-6.1-sol:none')).toThrow('allowed: low, medium, high, xhigh, max')
		expect(() => models.selection('openai/gpt-6-luna:minimal')).toThrow('unsupported effort')
		expect(() => models.selection('ollama/qwen3:8b:high')).toThrow('no verified effort control')
	} finally { models.known = known; auth.envKey = envKey }
})

test('frontier bodies map validated explicit effort without changing default policy or encrypted replay', () => {
	let messages = [{ role: 'user' as const, blocks: [{ type: 'text' as const, text: 'hi' }] }]
	for (let model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
		let body = anthropic.body({ model, effort: 'max', messages }, false)
		expect(body.thinking).toEqual({ type: 'adaptive' })
		expect(body.output_config).toEqual({ effort: 'max' })
		expect(anthropic.body({ model, messages }, false).output_config).toBeUndefined()
		expect(() => anthropic.body({ model, effort: 'none', messages }, false)).toThrow('unsupported effort')
	}
	for (let model of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']) {
		let body = openai.body({ model, effort: 'max', messages }, false)
		expect(body.reasoning).toEqual({ summary: 'auto', effort: 'max' })
		expect(body.include).toEqual(['reasoning.encrypted_content'])
	}
	expect(openai.body({ model: 'gpt-6-luna', effort: 'none', messages }, false).reasoning).toEqual({ summary: 'auto', effort: 'none' })
	expect(() => effort.wire('anthropic', 'claude-sonnet-4-5', 'high', 10000)).toThrow('must be below')
	expect(effort.wire('custom', 'unknown')).toEqual({})
})

test('gateway metadata distinguishes missing/null effort values and mandatory thinking; endpoint hook reaches body', async () => {
	let fetch = provider.fetch
	let endpoint = openaiCompat.endpoint
	let registered = provider.state.providers.openrouter
	let p = openaiCompat.create('openrouter')
	provider.state.providers.openrouter = p
	openaiCompat.endpoint = () => ({ base: 'https://example.com', headers: {} })
	provider.fetch = async () => new Response(JSON.stringify({ data: [
		{ id: 'missing', reasoning: {} },
		{ id: 'all', reasoning: { supported_efforts: null, mandatory: true, default_effort: 'high' } },
		{ id: 'limited', reasoning: { supported_efforts: ['low', 'high'] } },
	] }))
	try {
		await p.models!(new AbortController().signal)
		expect(effort.describe('openrouter/missing')).toBeUndefined()
		expect(effort.describe('openrouter/all')?.levels).not.toContain('none')
		expect(effort.describe('openrouter/all')?.default).toBe('high')
		expect((await p.request({ model: 'limited', effort: 'low', messages: [] })).body).toMatchObject({ reasoning: { effort: 'low' } })
		openaiCompat.state.capabilities.clear()
		openaiCompat.state.catalog = ''
		provider.fetch = async () => { throw new Error('No HTTP during capability restore') }
		expect((await p.request({ model: 'limited', effort: 'high', messages: [] })).body).toMatchObject({ reasoning: { effort: 'high' } })
		expect(() => p.request({ model: 'limited', effort: 'medium', messages: [] })).toThrow('allowed: low, high')
	} finally {
		provider.fetch = fetch; openaiCompat.endpoint = endpoint
		if (registered) provider.state.providers.openrouter = registered
		else delete provider.state.providers.openrouter
		openaiCompat.state.capabilities.clear()
	}
})
