import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import {
	parseModel,
	resolveModel,
	providerForModel,
	modelIdForModel,
	mergedModelAliases,
	getConfig,
	resetConfigCache,
} from './config.ts'

const CONFIG_PATH = `${process.cwd()}/config.ason`

describe('config model helpers', () => {
	test("parseModel('codex...') resolves provider openai", () => {
		expect(parseModel('codex')).toEqual({ provider: 'openai', modelId: 'codex' })
		expect(parseModel('codex-1')).toEqual({ provider: 'openai', modelId: 'codex-1' })
		expect(parseModel('openai/gpt-5.3-codex')).toEqual({
			provider: 'openai',
			modelId: 'gpt-5.3-codex',
		})
	})

	test("parseModel('ollama/...') resolves provider ollama", () => {
		expect(parseModel('ollama/llama3.2')).toEqual({ provider: 'ollama', modelId: 'llama3.2' })
		expect(parseModel('ollama:local')).toEqual({ provider: 'ollama', modelId: 'ollama:local' })
	})

	test("resolveModel('codex') maps to alias full model", () => {
		expect(resolveModel('codex')).toBe('openai/gpt-5.3-codex')
	})

	test('resolveModel includes built-in ollama alias', () => {
		expect(resolveModel('ollama')).toBe('ollama/llama3.2')
	})

	test('providerForModel and modelIdForModel handle bare + full IDs', () => {
		expect(providerForModel('codex')).toBe('openai')
		expect(modelIdForModel('codex')).toBe('gpt-5.3-codex')

		expect(providerForModel('gpt-5.3-codex')).toBe('openai')
		expect(modelIdForModel('gpt-5.3-codex')).toBe('gpt-5.3-codex')

		expect(providerForModel('openai/gpt-5.3-codex')).toBe('openai')
		expect(modelIdForModel('openai/gpt-5.3-codex')).toBe('gpt-5.3-codex')
	})

	test('mergedModelAliases includes built-ins by default', () => {
		const aliases = mergedModelAliases()
		expect(aliases.ollama).toBe('ollama/llama3.2')
		expect(aliases.codex).toBe('openai/gpt-5.3-codex')
	})
})

describe('config migration for ollamaBaseUrl', () => {
	const original = readFileSync(CONFIG_PATH, 'utf-8')

	beforeEach(() => {
		writeFileSync(
			CONFIG_PATH,
			"{ defaultModel: 'anthropic/claude-opus-4-6', ollamaBaseUrl: 'http://localhost:11434' }\n",
		)
		resetConfigCache()
	})

	afterEach(() => {
		writeFileSync(CONFIG_PATH, original)
		resetConfigCache()
	})
	test('getConfig creates providers.ollama for deprecated ollamaBaseUrl', () => {
		const cfg = getConfig()
		expect(cfg.providers?.ollama?.protocol).toBe('openai-completions')
		expect(cfg.providers?.ollama?.baseUrl).toBe('http://localhost:11434/v1')
		expect(cfg.providers?.ollama?.auth).toBe('none')
	})

	test('config can still resolve ollama alias after migration', () => {
		void getConfig()
		expect(resolveModel('ollama')).toBe('ollama/llama3.2')
	})
})
