// A model question uses the same durable form as commands and synthetic
// models. The turn parks before tools.run and resumes after an answer.
import { forms, type Field, type Form } from '../../common/forms.ts'
import type { ToolCallBlock } from '../../common/blocks.ts'
import type { HistoryRecord } from '../../common/replay.ts'
import type { Tool } from '../tools.ts'

type InputField = { type: string; name: string; label?: string; placeholder?: string; options?: string[] }

function form(input: Record<string, unknown>): Form {
	if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('ask needs a question in text')
	let fields = input.fields === undefined ? [{ type: 'text', name: 'answer' }] : input.fields
	if (!Array.isArray(fields) || !fields.length) throw new Error('ask needs fields')
	let mapped: Field[] = fields.map((f: InputField) => {
		if (!f || typeof f !== 'object' || typeof f.name !== 'string' || !f.name.trim()) throw new Error('ask fields need names')
		if (f.label !== undefined && typeof f.label !== 'string') throw new Error(`${f.name}: label must be text`)
		if (f.type === 'secret') throw new Error('ask cannot request secret fields')
		if (f.type === 'confirm') return { type: 'choice', name: f.name, ...(f.label !== undefined && { label: f.label }), options: ['yes', 'no'], initial: 1 }
		if (f.type === 'choice') {
			if (!Array.isArray(f.options) || !f.options.length || f.options.some((o) => typeof o !== 'string')) throw new Error(`${f.name}: choices need options`)
			return { type: 'choice', name: f.name, ...(f.label !== undefined && { label: f.label }), options: f.options }
		}
		if (f.type !== 'text') throw new Error(`${f.name}: unknown field type`)
		if (f.placeholder !== undefined && typeof f.placeholder !== 'string') throw new Error(`${f.name}: placeholder must be text`)
		return { type: 'text', name: f.name, ...(f.label !== undefined && { label: f.label }), ...(f.placeholder !== undefined && { placeholder: f.placeholder }) }
	})
	let result: Form = { text: input.text, fields: mapped }
	let problem = forms.invalid(result)
	if (problem) throw new Error(problem)
	return result
}

// Tool ids are local to a batch: a later round can reuse the same id.
function pending(records: HistoryRecord[], id: string): HistoryRecord[] {
	let at = records.findLastIndex((r) => r.type === 'assistant' && r.block.type === 'tool_call' && r.block.id === id && r.block.name === 'ask')
	return records.slice(at + 1)
}

function answered(records: HistoryRecord[], call: ToolCallBlock): boolean {
	let after = tool.pending(records, call.id)
	let questions = after.filter((r): r is Extract<HistoryRecord, { type: 'question' }> => r.type === 'question' && r.call === call.id)
	return questions.some((r) => after.some((a) => a.type === 'answer' && a.question === r.id))
}

export const tool: Tool & { form: typeof form; pending: typeof pending; answered: typeof answered } = {
	name: 'ask',
	description: 'Ask the user only when a choice truly needs them. Never ask for anything you can find out yourself. Do not request secrets. The answer is returned as plain text.',
	parameters: {
		type: 'object',
		properties: {
			text: { type: 'string', description: 'The question shown to the user' },
			fields: { type: 'array', description: 'Optional text, choice (options), or confirm fields; defaults to one text answer', items: { type: 'object', properties: { type: { type: 'string', enum: ['text', 'choice', 'confirm'] }, name: { type: 'string' }, label: { type: 'string' }, placeholder: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['type', 'name'] } },
		},
		required: ['text'],
	},
	form,
	pending,
	answered,
	async run(input, ctx) {
		tool.form(input)
		if (!ctx.callId) throw new Error('ask needs a call id')
		let records = (await import('../history.ts')).history.readSync(ctx.sessionId)
		let after = tool.pending(records, ctx.callId)
		let last = after.findLast((r) => r.type === 'question' && r.call === ctx.callId)
		if (!last || last.type !== 'question') throw new Error('ask has no question')
		let reply = after.find((r) => r.type === 'answer' && r.question === last.id)
		if (reply?.type !== 'answer') throw new Error('ask has no answer')
		return reply.cancelled ? 'The user declined to answer.' : Object.entries(reply.answers).map(([name, value]) => `${name}: ${value}`).join('\n')
	},
}
