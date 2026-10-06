// hal/queue-test: a scripted model for testing steering, queued
// messages, editing and discarding by hand (task 0za). Each round says
// which user messages reached it since the previous round, read from
// history alone so a restarted host agrees; then it thinks for a few
// seconds and runs a harmless bash call. After `rounds` rounds it
// answers and stops. Nothing it does writes files.
import type { StreamEvent } from '../common/blocks.ts'
import type { HistoryRecord } from '../common/replay.ts'
import type { Reply } from './synthetic.ts'

const rounds = 30
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

// Where the turn began: after the last turn end that no continue resumed.
function start(records: HistoryRecord[]): number {
	let resumed = false
	for (let i = records.length - 1; i >= 0; i--) {
		let r = records[i]!
		if (r.type === 'continue') resumed = true
		else if (r.type === 'turn_end') {
			if (!resumed) return i + 1
			resumed = false
		}
	}
	return 0
}

const clock = (ts: string | undefined) => (ts ? new Date(ts).toTimeString().slice(0, 8) : '?')

// One line per user text that arrived after the model last spoke.
function arrived(records: HistoryRecord[]): string[] {
	let sent = new Map<string, string>()
	for (let r of records) if (r.type === 'inbox' && !sent.has(r.id)) sent.set(r.id, r.ts)
	let last = records.findLastIndex((r) => r.type === 'assistant')
	let lines: string[] = []
	for (let r of records.slice(last + 1)) {
		if (r.type !== 'user') continue
		let texts = r.blocks.filter((b) => b.type === 'text')
		for (let [i, b] of texts.entries()) {
			let id = r.inbox?.[i]
			let how = b.from !== undefined ? `from ${b.label ?? b.from}, ${b.advisory ? 'advisory' : b.steering ? 'steering' : b.queuedAt ? 'queued' : 'prompt'}`
				: b.origin === 'model' ? 'from Hal'
				: b.steering ? 'You, steering'
				: b.queuedAt !== undefined || r.queued ? 'You, queued'
				: 'You, prompt'
			let at = b.queuedAt ?? (id && sent.get(id)) ?? r.ts
			lines.push(`- sent ${clock(at)}, arrived ${clock(r.ts)} · ${how}: ${JSON.stringify(b.text)}`)
		}
	}
	return lines
}

function report(n: number, lines: string[]): { head: string; body: string } {
	let count = lines.length ? `${lines.length} new message${lines.length > 1 ? 's' : ''}` : 'no new messages'
	return { head: `Round ${n} of ${rounds}: ${count}.`, body: lines.length ? `Round ${n}. New messages since the last round:\n${lines.join('\n')}` : `Round ${n}: no new messages.` }
}

async function* round(n: number, lines: string[]): AsyncGenerator<StreamEvent> {
	let { head, body } = report(n, lines)
	let thought = `${head}\n\nReading the history for messages that arrived since the last round, then pretending to work for a while so there is time to steer, queue, edit or discard a message.`
	// Short steps: a steer interrupts at the next one.
	let words = thought.split(/(?<=\s)/)
	for (let [i, word] of words.entries()) {
		if (i) await sleep(4000 / words.length)
		yield { type: 'thinking', text: word }
	}
	yield { type: 'signature', value: '' }
	yield { type: 'text', text: body }
	let command = `sleep 3; echo round ${n}`
	yield { type: 'tool_call', id: `queue-test-${Date.now()}`, name: 'bash', input: { command, description: `Wait 3 seconds (round ${n})` } }
	yield { type: 'done', reason: 'tool_use' }
}

function run(records: HistoryRecord[]): Reply {
	let n = records.slice(start(records)).filter((r) => r.type === 'assistant' && r.block.type === 'tool_call').length
	let lines = arrived(records)
	if (n < rounds) return { stream: round(n + 1, lines) }
	let { body } = report(n + 1, lines)
	let say = lines.length ? `${body}\n\n` : ''
	return { say: `${say}Finished ${rounds} rounds.\n\n<summary>Ran ${rounds} scripted queue-test rounds.</summary>` }
}

export const queueTest = { run, start, arrived }
