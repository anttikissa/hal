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
