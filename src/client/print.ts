// `hal -p` (task gw): one prompt in a new tab of this home's host, then
// the turn's final text on stdout. The tab is an ordinary one: any
// client may watch, steer, answer or pause it meanwhile.

import { connection } from '../common/connection.ts'
import type { Event } from '../common/protocol.ts'
import { summary } from '../common/summary.ts'

type Job = { prompt: string; cwd: string; model?: string }
type Out = { out(text: string): void; err(text: string): void }

// Drives the session through connection.send and the events given to
// onEvent; begin() once connected (connection.start forgets earlier
// commands). `done` resolves with the exit code.
function run(job: Job, io: Out): { onEvent(event: Event): void; begin(): void; done: Promise<number> } {
	let finish!: (code: number) => void
	let done = new Promise<number>((resolve) => (finish = resolve))
	let id = ''
	let session = ''
	let modelId = ''
	let promptId = ''
	let started = false
	let text = ''
	let fail = (why: string) => (io.err(`hal: ${why}\n`), finish(1))
	let submit = () => {
		promptId = connection.nextId()
		connection.send({ type: 'submit', sessionId: session, text: job.prompt, id: promptId })
	}
	let begin = () => {
		id = connection.nextId()
		connection.send({ type: 'tab-new', cwd: job.cwd, id })
	}
	let onEvent = (e: Event) => {
		if (e.type === 'warning') return io.err(`hal: ${e.text}\n`)
		if (e.type === 'rejected' && e.id !== undefined && [id, modelId, promptId].includes(e.id)) return fail(e.reason)
		if (e.type === 'ack' && e.id === id && e.tab) {
			session = e.tab
			connection.send({ type: 'open', sessionId: session })
			if (!job.model) return submit()
			modelId = connection.nextId()
			return connection.send({ type: 'submit', sessionId: session, text: `/model ${job.model}`, id: modelId })
		}
		if (!('sessionId' in e) || e.sessionId !== session) return
		// The prompt goes once /model has said whether it switched.
		if (e.type === 'output' && modelId && !promptId) {
			if (!e.error) return submit()
			connection.send({ type: 'tab-close', sessionId: session })
			return fail(e.text)
		}
		if (e.type === 'turn-start' && e.command === promptId) started = true
		else if (!started) return
		else if (e.type === 'stream' && e.event.type === 'tool_call') text = ''
		else if (e.type === 'stream' && e.event.type === 'text' && !e.event.naming) text += e.event.text
		else if (e.type === 'question') io.err(`hal: waiting for an answer in Hal: ${e.form.text}\n`)
		else if (e.type === 'turn-end' && e.status === 'completed') {
			io.out(`${summary.strip(text).trim()}\n`)
			finish(0)
		}
		else if (e.type === 'turn-end') fail(`turn ${e.status}${e.error ? `: ${e.error}` : ''}`)
	}
	return { onEvent, begin, done }
}

export const print = { run }
