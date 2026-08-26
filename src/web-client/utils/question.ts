import type { AnswerValue } from '../../common/history.ts'
import type { ProjectedQuestion } from '../../common/history-projection.ts'
import { questionCrypto } from '../../common/question-crypto.ts'

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength
}

function projected(value: unknown): ProjectedQuestion | undefined {
	if (!value || typeof value !== 'object') return undefined
	const entry = value as Record<string, unknown>
	if (entry.type !== 'question' || typeof entry.active !== 'boolean') return undefined
	return value as ProjectedQuestion
}

async function prepareAnswer(question: ProjectedQuestion, value: string): Promise<AnswerValue> {
	if (question.input.kind === 'choice') {
		if (!question.input.choices.some((choice) => choice.id === value)) throw new Error('Choose one of the available answers.')
		return { kind: 'choice', choiceId: value }
	}
	if (question.input.kind === 'text') {
		if (!question.input.allowEmpty && !value.trim()) throw new Error('Enter an answer.')
		return { kind: 'text', text: value }
	}
	if (!value) throw new Error('Enter a secret answer.')
	if (byteLength(value) > question.input.maxBytes) throw new Error(`Secret answers are limited to ${question.input.maxBytes} bytes.`)
	const ciphertext = await questionCrypto.encryptSecret(question.input.publicKey, value)
	return { kind: 'secret', ciphertext }
}

function answerText(question: ProjectedQuestion): string {
	const answer = question.answer
	if (!answer) return question.inherited ? 'Waiting in parent session' : 'Waiting for answer'
	if (answer.kind === 'aborted') return 'Aborted'
	if (answer.kind === 'secret') return 'Secret sent'
	if (answer.kind === 'text') return answer.text || 'Answered'
	if (question.input.kind !== 'choice') return 'Answered'
	return question.input.choices.find((item) => item.id === answer.choiceId)?.label ?? 'Answered'
}

export const webQuestion = { byteLength, projected, prepareAnswer, answerText }
