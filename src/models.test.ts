import { test, expect, describe, beforeEach } from 'bun:test'
import { resolveModel, displayModel, resolveFastModel, listModels } from './models.ts'

// ── resolveModel ──

test('resolveModel: pass-through for provider/model format', () => {
	expect(resolveModel('anthropic/claude-opus-4-6')).toBe('anthropic/claude-opus-4-6')
	expect(resolveModel('openai/gpt-5.4')).toBe('openai/gpt-5.4')
})

test('resolveModel: opus alias', () => {
	expect(resolveModel('opus')).toBe('anthropic/claude-opus-4-6')
})

test('resolveModel: claude alias → default opus', () => {
	expect(resolveModel('claude')).toBe('anthropic/claude-opus-4-6')
})

test('resolveModel: sonnet alias', () => {
	expect(resolveModel('sonnet')).toBe('anthropic/claude-sonnet-4-20250514')
})

test('resolveModel: opus-X pattern', () => {
	expect(resolveModel('opus-4-5')).toBe('anthropic/claude-opus-4-5')
	expect(resolveModel('opus-4-6')).toBe('anthropic/claude-opus-4-6')
})

test('resolveModel: sonnet-X pattern', () => {
	expect(resolveModel('sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6')
	expect(resolveModel('sonnet-4-20250514')).toBe('anthropic/claude-sonnet-4-20250514')
})

test('resolveModel: mock alias', () => {
	expect(resolveModel('mock')).toBe('mock/mock-1')
})

test('resolveModel: unknown name passes through as-is', () => {
	expect(resolveModel('some-random-thing')).toBe('some-random-thing')
})

test('resolveModel: gpt aliases', () => {
	expect(resolveModel('gpt54')).toBe('openai/gpt-5.4')
	expect(resolveModel('gpt53')).toBe('openai/gpt-5.3')
	expect(resolveModel('gpt52')).toBe('openai/gpt-5.2')
})

test('resolveModel: gpt-X.Y pattern', () => {
	expect(resolveModel('gpt-5.4')).toBe('openai/gpt-5.4')
	expect(resolveModel('gpt5.3')).toBe('openai/gpt-5.3')
})

test('resolveModel: codex aliases', () => {
	expect(resolveModel('codex')).toBe('openai/gpt-5.3-codex')
	expect(resolveModel('codex-spark')).toBe('openai/gpt-5.3-codex-spark')
})

test('resolveModel: codex-X.Y pattern', () => {
	expect(resolveModel('codex-5.2')).toBe('openai/gpt-5.2-codex')
})

// ── displayModel ──

test('displayModel: claude-opus-4-6 → Opus 4.6', () => {
	expect(displayModel('anthropic/claude-opus-4-6')).toBe('Opus 4.6')
})

test('displayModel: claude-opus-4-5 → Opus 4.5', () => {
	expect(displayModel('anthropic/claude-opus-4-5')).toBe('Opus 4.5')
})

test('displayModel: claude-sonnet-4-6 → Sonnet 4.6', () => {
	expect(displayModel('anthropic/claude-sonnet-4-6')).toBe('Sonnet 4.6')
})

test('displayModel: claude-sonnet-4-20250514 → Sonnet 4', () => {
	expect(displayModel('anthropic/claude-sonnet-4-20250514')).toBe('Sonnet 4')
})

test('displayModel: gpt-5.4 → GPT 5.4', () => {
	expect(displayModel('openai/gpt-5.4')).toBe('GPT 5.4')
	expect(displayModel('openai/gpt-5.3')).toBe('GPT 5.3')
	expect(displayModel('openai/gpt-5.2')).toBe('GPT 5.2')
})

test('displayModel: codex models', () => {
	expect(displayModel('openai/gpt-5.3-codex')).toBe('Codex 5.3')
	expect(displayModel('openai/gpt-5.3-codex-spark')).toBe('Codex Spark 5.3')
	expect(displayModel('openai/gpt-5.2-codex')).toBe('Codex 5.2')
})

test('displayModel: no provider prefix passes through', () => {
	expect(displayModel('mock-1')).toBe('mock-1')
})

test('displayModel: works with undefined/empty', () => {
	expect(displayModel('')).toBe('')
	expect(displayModel(undefined)).toBe('')
})

// ── resolveFastModel ──

import { config } from './config.ts'
import { auth } from './runtime/auth.ts'

describe('resolveFastModel', () => {
	let origGetConfig: typeof config.getConfig
	let origGetAuth: typeof auth.getAuth

	beforeEach(() => {
		origGetConfig = config.getConfig
		origGetAuth = auth.getAuth
	})

	function mockConfig(overrides: Record<string, any>) {
		config.getConfig = () => ({ defaultModel: 'anthropic/claude-opus-4-6', ...overrides }) as any
	}

	function mockAuth(providers: Record<string, { accessToken?: string }>) {
		auth.getAuth = (p: string) => providers[p] ?? {}
	}

	test('explicit fastModel in config', () => {
		mockConfig({ fastModel: 'openai/gpt-4o-mini' })
		mockAuth({ anthropic: { accessToken: 'sk-ant-xxx' } })
		expect(resolveFastModel()).toBe('openai/gpt-4o-mini')
		config.getConfig = origGetConfig
		auth.getAuth = origGetAuth
	})

	test('auto with anthropic auth → haiku', () => {
		mockConfig({})
		mockAuth({ anthropic: { accessToken: 'sk-ant-xxx' } })
		expect(resolveFastModel()).toBe('anthropic/claude-3-5-haiku-20241022')
		config.getConfig = origGetConfig
		auth.getAuth = origGetAuth
	})

	test('auto with only openai auth → gpt-4o-mini', () => {
		mockConfig({})
		mockAuth({ openai: { accessToken: 'sk-xxx' } })
		expect(resolveFastModel()).toBe('openai/gpt-4o-mini')
		config.getConfig = origGetConfig
		auth.getAuth = origGetAuth
	})

	test('auto with both → prefers anthropic', () => {
		mockConfig({})
		mockAuth({ anthropic: { accessToken: 'a' }, openai: { accessToken: 'b' } })
		expect(resolveFastModel()).toBe('anthropic/claude-3-5-haiku-20241022')
		config.getConfig = origGetConfig
		auth.getAuth = origGetAuth
	})

	test('auto with no auth → empty string', () => {
		mockConfig({})
		mockAuth({})
		expect(resolveFastModel()).toBe('')
		config.getConfig = origGetConfig
		auth.getAuth = origGetAuth
	})

	test('alias in fastModel gets resolved', () => {
		mockConfig({ fastModel: 'sonnet' })
		mockAuth({})
		expect(resolveFastModel()).toBe('anthropic/claude-sonnet-4-20250514')
		config.getConfig = origGetConfig
		auth.getAuth = origGetAuth
	})
})

// ── listModels ──

describe('listModels', () => {
	test('shows anthropic models first when anthropic has auth', () => {
		const lines = listModels(p => p === 'anthropic')
		const anthropicIdx = lines.indexOf(lines.find(l => l.includes('Anthropic'))!)
		const openaiIdx = lines.indexOf(lines.find(l => l.includes('OpenAI'))!)
		expect(anthropicIdx).toBeLessThan(openaiIdx)
	})

	test('shows openai models first when only openai has auth', () => {
		const lines = listModels(p => p === 'openai')
		const anthropicIdx = lines.indexOf(lines.find(l => l.includes('Anthropic'))!)
		const openaiIdx = lines.indexOf(lines.find(l => l.includes('OpenAI'))!)
		expect(openaiIdx).toBeLessThan(anthropicIdx)
	})

	test('includes alias and full model id', () => {
		const lines = listModels(() => false)
		const opusLine = lines.find(l => l.includes('opus'))
		expect(opusLine).toContain('anthropic/claude-opus-4-6')
	})

	test('marks authenticated providers', () => {
		const lines = listModels(p => p === 'anthropic')
		const header = lines.find(l => l.includes('Anthropic'))!
		expect(header).toMatch(/✓|authenticated/)
	})

	test('includes all aliases', () => {
		const text = listModels(() => false).join('\n')
		expect(text).toContain('opus')
		expect(text).toContain('sonnet')
		expect(text).toContain('codex')
	})
})