// Commands and what they said, as transcript items: a human's command
// and its adjacent output share one card. Split out of transcript.ts.
// Tasks: ca, 179.

import type { CommitBlock } from './blocks.ts'
import { card } from './card.ts'
import type { Form } from './forms.ts'
import type { PromptChange } from './replay.ts'
import type { Item, Shown } from './transcript.ts'

function aside(
	r:
		| { type: 'command'; text: string; from?: string; label?: string; ts?: string }
		| {
				type: 'output'
				text: string
				error?: true
				synthetic?: true
				change?: PromptChange
				commit?: CommitBlock
				notice?: true
				dropped?: number
				ts?: string
		  }
		| { type: 'divider'; text: string; ts?: string; clear?: true }
		| { type: 'question'; id: string; form: Form; ts?: string },
): Shown {
	if (r.type === 'question')
		return { type: 'question', id: r.id, form: r.form, command: true, ...(r.ts !== undefined && { ts: r.ts }) }
	if (r.type === 'divider')
		return { type: r.clear ? 'output' : 'divider', text: r.text, ...(r.ts !== undefined && { ts: r.ts }) }
	if (r.type === 'command')
		return {
			type: 'command',
			text: r.text,
			...(r.from !== undefined && { from: r.from }),
			...(r.label !== undefined && { label: r.label }),
			...(r.ts !== undefined && { ts: r.ts }),
		}
	return r.synthetic
		? { type: 'text', text: r.text, synthetic: true, ...(r.ts !== undefined && { ts: r.ts }) }
		: {
				type: 'output',
				text: r.dropped === undefined ? r.text : `Queue item #${r.dropped} was dropped: ${r.text}`,
				...(r.error && { error: true }),
				...(r.change && { change: r.change }),
				...(r.commit && { commit: r.commit }),
				...((r.notice || r.dropped !== undefined) && { notice: true }),
				...(r.ts !== undefined && { ts: r.ts }),
			}
}

// Whether output `next` joins the human's command `prev` in one card:
// the command, then what it said, adjacent. Output with its own card
// kind keeps its card; synthetic text is a reply.
function joins(prev: Item, next: Item): prev is Item & { type: 'command' } {
	return prev.type === 'command' && prev.from === undefined && next.type === 'output' && !card.kind(next)
}

// Command `cmd` with `out` said after it.
function join(cmd: Item & { type: 'command' }, out: Item): Item {
	let o = out as Item & { type: 'output' }
	return {
		...cmd,
		output: cmd.output === undefined ? o.text : `${cmd.output}\n\n${o.text}`,
		...((cmd.error || o.error) && { error: true as const }),
	}
}

// `items` with each human command's adjacent output joined into it.
function joined(items: Item[]): Item[] {
	let out: Item[] = []
	for (let item of items) {
		let last = out.at(-1)
		if (last && commandCards.joins(last, item)) out[out.length - 1] = commandCards.join(last, item)
		else out.push(item)
	}
	return out
}

export const commandCards = { aside, joins, join, joined }
