// Synthetic models: Hal's own scripted "models" under the provider name
// `hal`, run in the host instead of a provider. Unlike real models they
// may ask the human a durable question (tasks/w4/forms.md): a reply is
// what to say and, optionally, a form to ask. Nothing waits for the
// answer; once it is in history the model runs again and reads it
// there. Secrets are not in history: `answers` carries the fresh answer
// to the question just answered, secrets included, when there is one.

import type { Answers, Form } from '../common/forms.ts'
import type { HistoryRecord } from '../common/replay.ts'

export type Reply = { say?: string; ask?: Form }
export type Synthetic = (records: HistoryRecord[], answers?: Answers) => Reply

// hal/intro asks your name, then uses it.
function intro(records: HistoryRecord[]): Reply {
	let answer = records.findLast((r) => r.type === 'answer')
	if (!answer || answer.type !== 'answer') {
		return {
			say: 'Hello, I am Hal.',
			ask: { text: 'How should I call you?', fields: [{ type: 'text', name: 'name', placeholder: 'leave empty to stay nameless' }] },
		}
	}
	let name = answer.answers.name?.trim()
	// Not greeted since the answer (a steered message may follow it).
	let fresh = !records.slice(records.indexOf(answer)).some((r) => r.type === 'assistant')
	if (!name) return { say: fresh ? 'Fine, you stay nameless.' : 'Hello again, stranger.' }
	return { say: fresh ? `Nice to meet you, ${name}.` : `Hello again, ${name}.` }
}

// The synthetic model with this full id (hal/intro), if there is one.
function find(model: string): Synthetic | undefined {
	return model.startsWith('hal/') ? synthetic.models[model.slice(4)] : undefined
}

export const synthetic = {
	models: { intro } as Record<string, Synthetic>,
	find,
}
