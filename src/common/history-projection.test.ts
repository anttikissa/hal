import { expect, test } from 'bun:test'
import { historyProjection } from './history-projection.ts'

test('input history projects local persisted user input with display text', () => {
	const entries = [
		{ type: 'user' as const, parts: [{ type: 'text' as const, text: 'pasted text', displayText: '[...paste]' }] },
		{ type: 'user' as const, parts: [{ type: 'text' as const, text: 'handoff' }], source: '04-other' },
	]

	expect(historyProjection.inputHistoryFromEntries(entries)).toEqual(['[...paste]'])
})


test('question projection pairs first answers and exposes only the first actionable question', () => {
	const entries: any[] = [
		{ type: 'tool_call', id: 'call-row', toolId: 'tool-a', name: 'bash', input: { command: 'rm one' } },
		{ type: 'pending_tools', id: 'pending-a', toolIds: ['tool-a', 'tool-b'], cwd: '/tmp' },
		{ type: 'question', id: 'question-a', text: 'Allow one?', input: { kind: 'choice', choices: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }] }, source: { type: 'tool', pendingId: 'pending-a', toolId: 'tool-a' } },
		{ type: 'question', id: 'question-b', text: 'Allow two?', input: { kind: 'choice', choices: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }] }, source: { type: 'tool', pendingId: 'pending-a', toolId: 'tool-b' } },
		{ type: 'answer', questionId: 'question-a', value: { kind: 'choice', choiceId: 'yes' } },
		{ type: 'answer', questionId: 'question-a', value: { kind: 'choice', choiceId: 'no' } },
	]

	expect(historyProjection.questions(entries)).toEqual([
		expect.objectContaining({ id: 'question-a', answer: { kind: 'choice', choiceId: 'yes' }, active: false, progress: { index: 1, total: 2 }, tool: { name: 'bash', input: { command: 'rm one' } } }),
		expect.objectContaining({ id: 'question-b', active: true, progress: { index: 2, total: 2 } }),
	])
})

test('inherited questions are never active and later local questions stay hidden', () => {
	const entries: any[] = [
		{ type: 'question', id: 'parent-question', text: 'Parent?', input: { kind: 'text' }, source: { type: 'intro' } },
		{ type: 'forked_from', parent: '01-parent' },
		{ type: 'question', id: 'local-one', text: 'First?', input: { kind: 'text' }, source: { type: 'intro' } },
		{ type: 'question', id: 'local-two', text: 'Second?', input: { kind: 'text' }, source: { type: 'intro' } },
	]

	expect(historyProjection.questions(entries, 1)).toEqual([
		expect.objectContaining({ id: 'parent-question', inherited: true, active: false }),
		expect.objectContaining({ id: 'local-one', active: true }),
	])
	expect(historyProjection.activeQuestion(entries, 1)?.id).toBe('local-one')
})
