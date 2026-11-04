// The turn state the marks (pages.ts) follow, record by record: the
// offsets of the few records from which the session's state, inbox and
// open question are found again without reading the whole history.
import { replay, type HistoryRecord } from '../common/replay.ts'
import type { Marks } from './pages.ts'

// The turn state after record `r`, at `offset`.
function follow(m: Marks, r: HistoryRecord, offset: number): void {
	if (r.type === 'output' && r.transition) m.transitions = [offset]
	if (r.type === 'output' && r.transitionCancel) (m.transitions ??= []).push(offset)
	if (r.type === 'output' && r.transitionDone) m.transitions = []
	if (r.type === 'user') delete m.reply
	if (r.type === 'assistant' && r.block.type === 'text') m.reply = offset
	if (r.type === 'question') {
		m.question = offset
		if (!r.from) {
			m.turnQuestion = r.id
			m.turn = offset
		}
	} else if (r.type === 'answer' || r.type === 'turn_end') {
		// A turn end is the turn's last record; it closes only a turn's
		// question (forms.open), so the last answer is kept apart.
		if (r.type === 'answer') m.answer = offset
		if (r.type === 'turn_end') m.ended = offset
		if (r.type === 'turn_end' || r.question === m.turnQuestion) m.turn = offset
	} else if (r.type === 'inbox' && r.withdrawn) delete m.inbox[r.id]
	// Every record of a message: an edit keeps the place of the first.
	else if (r.type === 'inbox') m.inbox[r.id] = [...[m.inbox[r.id] ?? []].flat(), offset]
	else if (
		(r.type === 'user' && (r.notices === undefined || r.blocks.length)) ||
		r.type === 'assistant' ||
		r.type === 'continue'
	) {
		m.turn = offset
		if (replay.isPrompt(r)) m.prompt = offset
		if (r.type === 'user') for (let id of r.inbox ?? []) delete m.inbox[id]
	}
}

// The positions of the records the state needs, ascending.
function picked(m: Marks): number[] {
	return [
		...new Set(
			[
				m.question,
				m.answer,
				m.ended,
				m.turn,
				m.prompt,
				...Object.values(m.inbox).flat(),
				...(m.transitions ?? []),
			].filter((o) => o !== undefined),
		),
	].sort((a, b) => a - b)
}

export const turnMarks = { follow, picked }
