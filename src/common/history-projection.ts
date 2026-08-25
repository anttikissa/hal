import type { HistoryEntry } from './history.ts'

export type UserTextOptions = {
	separator?: string
	images?: 'omit' | 'path-or-image' | 'path-or-blob-or-image'
	display?: 'actual' | 'ui'
}

function userText(entry: Extract<HistoryEntry, { type: 'user' }>, opts: UserTextOptions | string = {}): string {
	const options = typeof opts === 'string' ? { separator: opts } : opts
	const separator = options.separator ?? ''
	const images = options.images ?? 'omit'
	const parts: string[] = []
	for (const part of entry.parts) {
		if (part.type === 'text') {
			const text = options.display === 'ui' ? part.displayText ?? part.text : part.text
			if (text) parts.push(text)
			continue
		}
		if (images === 'path-or-image') {
			parts.push(part.originalFile ? `[${part.originalFile}]` : '[image]')
			continue
		}
		if (images === 'path-or-blob-or-image') {
			const ref = part.originalFile ?? part.blobId
			parts.push(ref ? `[${ref}]` : '[image]')
		}
	}
	return parts.join(separator)
}

function noticeText(text: string): string {
	const marker = text.match(/^\[([A-Za-z][^\]\n]*)\]$/)
	if (!marker) return text
	return marker[1]![0]!.toUpperCase() + marker[1]!.slice(1)
}

function inputHistoryFromEntries(entries: HistoryEntry[]): string[] {
	const history: string[] = []
	for (const entry of entries) {
		let text = ''
		if (entry.type === 'input_history') text = entry.text
		// Inbox and subagent handoffs are persisted as user entries, but were not
		// typed by the local user and must stay out of up-arrow editing history.
		if (entry.type === 'user' && !entry.source) {
			text = historyProjection.userText(entry, { images: 'path-or-blob-or-image', display: 'ui' })
		}
		if (text && !text.startsWith('[system]')) history.push(text)
	}
	return history.slice(-200)
}


type QuestionEntry = Extract<HistoryEntry, { type: 'question' }>
type AnswerValue = Extract<HistoryEntry, { type: 'answer' }>['value']

export type ProjectedQuestion = QuestionEntry & {
	answer?: AnswerValue
	active: boolean
	inherited?: true
	progress?: { index: number; total: number }
	tool?: { name: string; input?: unknown }
}

function questions(entries: HistoryEntry[], parentCount = 0): ProjectedQuestion[] {
	const answers = new Map<string, AnswerValue>()
	const toolCalls = new Map<string, Extract<HistoryEntry, { type: 'tool_call' }>>()
	const localPending = new Set<string>()
	const totals = new Map<string, number>()
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!
		if (entry.canceled) continue
		if (entry.type === 'answer' && !answers.has(entry.questionId)) answers.set(entry.questionId, entry.value)
		if (entry.type === 'tool_call') toolCalls.set(entry.toolId, entry)
		if (entry.type === 'pending_tools' && entry.id && i >= parentCount) localPending.add(entry.id)
		if (entry.type === 'question' && entry.source.type === 'tool') totals.set(entry.source.pendingId, (totals.get(entry.source.pendingId) ?? 0) + 1)
	}

	let foundActive = false
	const progress = new Map<string, number>()
	const projected: ProjectedQuestion[] = []
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!
		if (entry.type !== 'question' || entry.canceled) continue
		const answer = answers.get(entry.id)
		const inherited = i < parentCount
		let actionable = !inherited && !answer
		let questionProgress: { index: number; total: number } | undefined
		let tool: { name: string; input?: unknown } | undefined
		if (entry.source.type === 'tool') {
			const index = (progress.get(entry.source.pendingId) ?? 0) + 1
			progress.set(entry.source.pendingId, index)
			questionProgress = { index, total: totals.get(entry.source.pendingId) ?? 1 }
			actionable &&= localPending.has(entry.source.pendingId)
			const call = toolCalls.get(entry.source.toolId)
			if (call) tool = { name: call.name, input: call.input }
		}
		const active = actionable && !foundActive
		if (active) foundActive = true
		// Completed and inherited questions remain useful transcript rows. Of the
		// local unanswered tail, only the active head is visible.
		if (!answer && !inherited && !active) continue
		const item: ProjectedQuestion = { ...entry, active }
		if (answer) item.answer = answer
		if (inherited) item.inherited = true
		if (questionProgress) item.progress = questionProgress
		if (tool) item.tool = tool
		projected.push(item)
	}
	return projected
}

function activeQuestion(entries: HistoryEntry[], parentCount = 0): ProjectedQuestion | undefined {
	return questions(entries, parentCount).find((question) => question.active)
}

export const historyProjection = { userText, noticeText, inputHistoryFromEntries, questions, activeQuestion }
