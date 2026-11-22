// A decision model answers the same typed questions about one item per turn.
import { ason } from '../common/ason.ts'
import type { StreamEvent } from '../common/blocks.ts'
import type { ProviderRequest } from './provider.ts'

export const decisions = {
	ids: new Set(['typesafe/jev-1.14', 'openai/gpt-6-luna-decisions']),
	is(model: string) {
		return model.startsWith('openrouter/') && decisions.ids.has(model.slice(11))
	},
	body(req: ProviderRequest) {
		let questions = ason.parse(req.system ?? '')
		if (!questions || typeof questions !== 'object' || Array.isArray(questions) || !Object.keys(questions).length)
			throw new Error('Decision models need an ASON map of questions as the system prompt')
		let msg = req.messages.at(-1)
		if (msg?.role !== 'user' || msg.blocks.some((b) => b.type !== 'text'))
			throw new Error('Expected a text decision input')
		let text = msg.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
		return {
			model: req.model,
			questions,
			state: text.trimStart().startsWith('{') ? ason.parse(text) : { message: text },
		}
	},
	*answer(text: string): Generator<StreamEvent> {
		let { answers, usage } = JSON.parse(text)
		if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
			yield { type: 'error', message: 'Missing decision answers', body: text }
			return
		}
		yield { type: 'text', text: ason.stringify(answers) }
		if (usage) {
			let cached = usage.input_tokens_details?.cached_tokens ?? 0
			yield {
				type: 'usage',
				usage: { input: (usage.input_tokens ?? 0) - cached, cacheRead: cached, output: usage.output_tokens ?? 0 },
			}
		}
		yield { type: 'done', reason: 'end' }
	},
}
