import { describe, test, expect } from 'bun:test'
import { promptAnalysis, type PromptAnalysis } from './prompt-analysis.ts'

describe('formatAnalysis', () => {
	test('short prompt', () => {
		const analysis: PromptAnalysis = {
			mood: 'curious',
			isHalChange: false,
			needsContext: false,
			topic: 'git status',
			durationMs: 142,
		}
		const result = promptAnalysis.formatAnalysis('git status', analysis)
		expect(result).toBe('[analysis] "git status" → curious topic="git status" 142ms')
	})

	test('long prompt is truncated', () => {
		const text = 'Can you refactor the entire rendering pipeline to use WebGL instead?'
		const analysis: PromptAnalysis = {
			mood: 'neutral',
			isHalChange: false,
			needsContext: false,
			topic: 'refactor rendering',
			durationMs: 87,
		}
		const result = promptAnalysis.formatAnalysis(text, analysis)
		expect(result).toContain('"Can you refactor the ent…"')
		expect(result).toContain('87ms')
	})

	test('hal change detected', () => {
		const analysis: PromptAnalysis = {
			mood: 'frustrated',
			isHalChange: true,
			needsContext: true,
			topic: 'fix TUI rendering',
			durationMs: 200,
		}
		const result = promptAnalysis.formatAnalysis('Fix the TUI rendering bug we discussed', analysis)
		expect(result).toContain('hal-change(ctx=true)')
		expect(result).toContain('frustrated')
	})

	test('hal change without context', () => {
		const analysis: PromptAnalysis = {
			mood: 'neutral',
			isHalChange: true,
			needsContext: false,
			topic: 'add dark mode',
			durationMs: 150,
		}
		const result = promptAnalysis.formatAnalysis('Add dark mode to Hal', analysis)
		expect(result).toContain('hal-change(ctx=false)')
	})
})

describe('extractRecentContext', () => {
	test('extracts last N user/assistant pairs', () => {
		const entries: any[] = [
			{ role: 'user', content: 'first question', ts: '2024-01-01T00:00:00Z' },
			{ role: 'assistant', text: 'first answer', ts: '2024-01-01T00:00:01Z' },
			{ role: 'user', content: 'second question', ts: '2024-01-01T00:00:02Z' },
			{ role: 'assistant', text: 'second answer', ts: '2024-01-01T00:00:03Z' },
			{ role: 'user', content: 'third question', ts: '2024-01-01T00:00:04Z' },
			{ role: 'assistant', text: 'third answer', ts: '2024-01-01T00:00:05Z' },
		]
		const result = promptAnalysis.extractRecentContext(entries, 2)
		expect(result).toHaveLength(4)
		expect(result[0].content).toBe('second question')
		expect(result[1].content).toBe('second answer')
		expect(result[2].content).toBe('third question')
		expect(result[3].content).toBe('third answer')
	})

	test('truncates long assistant replies', () => {
		const longText = 'x'.repeat(300)
		const entries: any[] = [
			{ role: 'user', content: 'question', ts: '2024-01-01T00:00:00Z' },
			{ role: 'assistant', text: longText, ts: '2024-01-01T00:00:01Z' },
		]
		const result = promptAnalysis.extractRecentContext(entries, 3)
		expect(result).toHaveLength(2)
		expect(result[1].content.length).toBeLessThanOrEqual(201)
		expect(result[1].content).toEndWith('…')
	})

	test('skips non-user/assistant entries', () => {
		const entries: any[] = [
			{ type: 'compact', ts: '2024-01-01T00:00:00Z' },
			{ role: 'user', content: 'hello', ts: '2024-01-01T00:00:01Z' },
			{ type: 'info', text: 'some info', ts: '2024-01-01T00:00:02Z' },
			{ role: 'assistant', text: 'hi', ts: '2024-01-01T00:00:03Z' },
		]
		const result = promptAnalysis.extractRecentContext(entries, 3)
		expect(result).toHaveLength(2)
		expect(result[0].content).toBe('hello')
		expect(result[1].content).toBe('hi')
	})

	test('handles image content blocks', () => {
		const entries: any[] = [
			{ role: 'user', content: [{ type: 'image', blobId: 'abc' }], ts: '2024-01-01T00:00:00Z' },
			{ role: 'assistant', text: 'nice image', ts: '2024-01-01T00:00:01Z' },
		]
		const result = promptAnalysis.extractRecentContext(entries, 3)
		expect(result[0].content).toBe('[image]')
	})

	test('handles mixed text+image content', () => {
		const entries: any[] = [
			{ role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image', blobId: 'abc' }], ts: '2024-01-01T00:00:00Z' },
			{ role: 'assistant', text: 'I see', ts: '2024-01-01T00:00:01Z' },
		]
		const result = promptAnalysis.extractRecentContext(entries, 3)
		expect(result[0].content).toBe('look at this')
	})
})