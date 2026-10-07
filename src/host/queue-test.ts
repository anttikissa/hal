// hal/queue-test: a scripted model for testing steering, queued
// messages, editing and discarding by hand (task 0za). Each round says
// which user messages reached it since the previous round, read from
// history alone so a restarted host agrees; then it thinks for a few
// seconds and runs a harmless bash call. A number in the prompt, or a
// later message that is just a number, means 'run that many more
// rounds' (default `rounds`); a message that is just 'stop' ends the
// turn at the next round. Round 1 says so. Nothing it does writes files.
// Tasks: rqq.
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
			let how = b.from !== undefined ? `from ${b.label ?? b.from}, ${b.advisory ? 'default delivery' : (b.delivery === 'now') ? 'steering' : b.queuedAt ? 'queued' : 'prompt'}`
				: b.origin === 'model' ? 'from Hal'
				: (b.delivery === 'now') ? 'You, steering'
				: b.queuedAt !== undefined || b.delivery === 'after-turn' ? 'You, queued'
				: 'You, prompt'
			let at = b.queuedAt ?? (id && sent.get(id)) ?? r.ts
			lines.push(`- sent ${clock(at)}, arrived ${clock(r.ts)} · ${how}: ${JSON.stringify(b.text)}`)
		}
	}
	return lines
}

// Where this turn should end, counted in rounds: each number means 'that
// many more rounds' from the round it arrived in; 'stop' means 'now'.
function planned(records: HistoryRecord[]): { total: number; stopped: boolean } {
	let plan = { total: rounds, stopped: false }
	let done = 0
	let first = true
	for (let r of records.slice(start(records))) {
		if (r.type === 'assistant' && r.block.type === 'tool_call') done++
		if (r.type !== 'user') continue
		for (let b of r.blocks) {
			if (b.type !== 'text') continue
			let t = b.text.trim()
			let n = Number((first ? t.match(/\b\d+\b/)?.[0] : /^\d+$/.test(t) && t) || NaN)
			if (n > 0) plan = { total: done + n, stopped: false }
			else if (t.toLowerCase() === 'stop') plan = { total: done, stopped: true }
			first = false
		}
	}
	return plan
}

const usage = "How to use: send a number (e.g. 3) to run that many more rounds, or 'stop' to end at the next round. Queue messages with Alt-Enter; they arrive after this turn ends. Ask another session to send messages to this session."

function report(n: number, lines: string[], total = rounds, note = ''): { head: string; body: string } {
	let count = lines.length ? `${lines.length} new message${lines.length > 1 ? 's' : ''}` : 'no new messages'
	let body = lines.length ? `Round ${n}. New messages since the last round:\n${lines.join('\n')}` : `Round ${n}: no new messages.`
	if (note) body += `\n\n${note}`
	return { head: `Round ${n} of ${total}: ${count}.`, body: n === 1 ? `${body}\n\n${usage}` : body }
}

async function* round(n: number, lines: string[], total: number, note: string): AsyncGenerator<StreamEvent> {
	let { head, body } = report(n, lines, total, note)
	let thought = `${head}\n\nReading the history for messages that arrived since the last round, then pretending to work for a while so there is time to steer, queue, edit or discard a message.`
	// Short steps: a steer interrupts at the next one.
	let words = thought.split(/(?<=\s)/)
	for (let [i, word] of words.entries()) {
		if (i) await sleep(queueTest.thinkMs / words.length)
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
	let { total, stopped } = planned(records)
	// Confirm a number that just arrived: compare with the plan before it.
	let spoke = records.findLastIndex((r) => r.type === 'assistant')
	let left = total - n
	let note = planned(records.slice(0, spoke + 1)).total !== total && !stopped ? `OK: ${left} round${left === 1 ? '' : 's'} left, ending after round ${total}.` : ''
	if (n < total && !stopped) return { stream: round(n + 1, lines, total, note) }
	let say = lines.length ? `New messages since the last round:\n${lines.join('\n')}\n\n` : ''
	let count = `${n} round${n === 1 ? '' : 's'}`
	let done = stopped ? `Stopped after ${count}, as asked.` : `Finished ${count}.`
	return { say: `${say}${done}\n\n<summary>${done}</summary>` }
}

// thinkMs: how long each round thinks; tests set it to 0.
export const queueTest = { run, start, arrived, thinkMs: 4000 }
