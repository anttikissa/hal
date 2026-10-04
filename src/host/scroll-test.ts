// hal/scroll-test: a scripted model that streams like a busy agent, to
// reproduce web scroll jumps on a real device. Each round thinks for a
// few seconds, then runs a real bash call that prints 30 lines over
// three seconds; after `rounds` rounds it answers and stops. Nothing it
// does writes files.
import type { StreamEvent } from '../common/blocks.ts'
import type { HistoryRecord } from '../common/replay.ts'
import type { Reply } from './synthetic.ts'

const rounds = 40
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

// Bash calls since the last human prompt (tool results are user records too).
function done(records: HistoryRecord[]): number {
	let n = 0
	for (let i = records.length - 1; i >= 0; i--) {
		let r = records[i]!
		if (r.type === 'user' && !r.blocks.some((b) => b.type === 'tool_result')) break
		if (r.type === 'assistant' && r.block.type === 'tool_call') n++
	}
	return n
}

async function* round(n: number): AsyncGenerator<StreamEvent> {
	for (let line of [`Round ${n} of ${rounds}. Checking the layout of the next card`, ', then the one after it,', ' and printing some output so the transcript grows.\n\nScroll up a little and watch whether the view moves.'])
	{
		yield { type: 'thinking', text: line }
		await sleep(1000)
	}
	yield { type: 'signature', value: '' }
	let command = `for i in $(seq 1 30); do echo "round ${n} line $i"; sleep 0.1; done`
	yield { type: 'tool_call', id: `scroll-test-${Date.now()}`, name: 'bash', input: { command, description: `Print 30 lines (round ${n})` } }
	yield { type: 'done', reason: 'tool_use' }
}

function run(records: HistoryRecord[]): Reply {
	let n = done(records)
	if (n >= rounds) return { say: `Finished ${rounds} rounds.` }
	return { stream: round(n + 1) }
}

export const scrollTest = { run }
