import { test, expect } from 'bun:test'
import { resolveModel, displayModel } from './models.ts'

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