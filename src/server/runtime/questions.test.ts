import { expect, test } from 'bun:test'
import { runtime } from '../runtime.ts'

const choice: any = {
	type: 'question',
	id: 'question-a',
	text: 'Continue?',
	input: { kind: 'choice', choices: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }] },
	source: { type: 'intro' },
}

test('validates answer kinds and choice ids', () => {
	expect(runtime.acceptsAnswer(choice, { kind: 'choice', choiceId: 'yes' })).toBe(true)
	expect(runtime.acceptsAnswer(choice, { kind: 'choice', choiceId: 'maybe' })).toBe(false)
	expect(runtime.acceptsAnswer(choice, { kind: 'text', text: 'yes' })).toBe(false)
	expect(runtime.acceptsAnswer(choice, { kind: 'aborted' })).toBe(true)
})

test('text questions reject empty input unless explicitly allowed', () => {
	expect(runtime.acceptsAnswer({ ...choice, input: { kind: 'text' } }, { kind: 'text', text: '' })).toBe(false)
	expect(runtime.acceptsAnswer({ ...choice, input: { kind: 'text', allowEmpty: true } }, { kind: 'text', text: '' })).toBe(true)
})
