import { expect, test } from 'bun:test'
import type { ProjectedQuestion } from '../../common/history-projection.ts'
import { questionCrypto } from '../../common/question-crypto.ts'
import { webQuestion } from './question.ts'

function question(input: ProjectedQuestion['input']): ProjectedQuestion {
	return {
		type: 'question',
		id: 'question-1',
		text: 'Answer?',
		input,
		source: { type: 'intro' },
		active: true,
	}
}

test('prepares only choices offered by the authoritative question', async () => {
	const item = question({ kind: 'choice', choices: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }] })
	expect(await webQuestion.prepareAnswer(item, 'no')).toEqual({ kind: 'choice', choiceId: 'no' })
	expect(webQuestion.prepareAnswer(item, 'maybe')).rejects.toThrow()
})

test('text answers preserve multiline content and enforce empty policy', async () => {
	expect(await webQuestion.prepareAnswer(question({ kind: 'text' }), 'one\ntwo')).toEqual({ kind: 'text', text: 'one\ntwo' })
	expect(webQuestion.prepareAnswer(question({ kind: 'text' }), '')).rejects.toThrow()
	expect(await webQuestion.prepareAnswer(question({ kind: 'text', allowEmpty: true }), '')).toEqual({ kind: 'text', text: '' })
})

test('secret answers enforce UTF-8 bytes and encrypt with the public key', async () => {
	const original = questionCrypto.encryptSecret
	const calls: unknown[][] = []
	questionCrypto.encryptSecret = async (...args) => {
		calls.push(args)
		return 'ciphertext'
	}
	try {
		const item = question({ kind: 'secret', publicKey: 'public-key', maxBytes: 190 })
		expect(await webQuestion.prepareAnswer(item, '秘密')).toEqual({ kind: 'secret', ciphertext: 'ciphertext' })
		expect(calls).toEqual([['public-key', '秘密']])
		expect(webQuestion.prepareAnswer(item, '')).rejects.toThrow()
		expect(webQuestion.prepareAnswer(item, 'é'.repeat(96))).rejects.toThrow()
		expect(calls).toHaveLength(1)
	} finally {
		questionCrypto.encryptSecret = original
	}
})

test('answered question summaries are safe and deterministic', () => {
	const item = question({ kind: 'choice', choices: [{ id: 'no', label: 'No' }] })
	expect(webQuestion.answerText({ ...item, active: false, answer: { kind: 'choice', choiceId: 'no' } })).toBe('No')
	expect(webQuestion.answerText({ ...item, active: false, answer: { kind: 'choice', choiceId: 'missing' } })).toBe('Answered')
	expect(webQuestion.answerText({ ...item, active: false, answer: { kind: 'secret', ciphertext: 'never show this' } })).toBe('Secret sent')
	expect(webQuestion.answerText({ ...item, active: false, answer: { kind: 'aborted' } })).toBe('Aborted')
})
