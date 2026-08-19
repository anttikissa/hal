import { expect, test } from 'bun:test'
import { transcriptTitles } from './transcript-titles.ts'

test("transcript titles use the terminal's time and model vocabulary", () => {
	expect(transcriptTitles.label({ type: 'assistant', text: 'Done', model: 'openai/gpt-5.6-sol', ts: '2026-08-13T15:17:00.000Z' })).toBe('15:17 Hal (GPT 5.6 Sol)')
	expect(transcriptTitles.label({ type: 'thinking', text: 'Checking', model: 'openai/gpt-5.6-terra', thinkingEffort: 'high', ts: '2026-08-13T15:11:00.000Z' })).toBe('15:11 Hal (GPT 5.6 Terra, thinking high)')
})

test('transcript titles reserve labels for actionable notices', () => {
	expect(transcriptTitles.label({ type: 'tool', name: 'bash', ts: Date.parse('2026-08-13T15:11:00.000Z') })).toBe('15:11 Bash')
	expect(transcriptTitles.label({ type: 'log', text: 'Prompt queued\n/model sol', ts: Date.parse('2026-08-13T15:09:00.000Z') })).toBe('15:09 Prompt queued')
	expect(transcriptTitles.label({ type: 'log', text: 'Restarted', ts: Date.parse('2026-08-13T15:10:00.000Z') })).toBe('15:10')
	expect(transcriptTitles.label({ type: 'info', text: 'model: old -> new', ts: Date.parse('2026-08-13T15:10:00.000Z') })).toBe('15:10')
})


test('transcript titles identify incoming messages with source details', () => {
	expect(transcriptTitles.label({
		type: 'user',
		text: 'handoff',
		source: '116-aye',
		sourceTab: 6,
		sourceName: 'Risky tool confirmation highlighting',
		ts: Date.parse('2026-08-19T08:08:00.000Z'),
	})).toBe('08:08 Message from 116-aye (tab 6: Risky tool confirmation highlighting)')
})
