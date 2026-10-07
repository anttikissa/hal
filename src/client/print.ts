// `hal -p`: one user prompt in a new or existing session, then its
// turn's final answer on stdout. Inbox receipt identifies the owning
// turn, so queued prompts do not return an unrelated running reply.
// Tasks: gw, 81y.

import { connection } from '../common/connection.ts'
import type { Delivery, Event } from '../common/protocol.ts'
import { summary } from '../common/summary.ts'

type Job = { prompt: string; cwd: string; model?: string; session?: string; keep?: true; delivery?: Delivery }
type Out = { out(text: string): void; err(text: string): void }

// begin() once connected; tabs may arrive asynchronously afterward.
// All requests use connection ids, preserving ordinary user provenance.
function run(job: Job, io: Out): { onEvent(event: Event): void; begin(): void; done: Promise<number> } {
	let finish!: (code: number) => void
	let done = new Promise<number>((resolve) => (finish = resolve))
	let id = '', session = '', modelId = '', promptId = ''
	let begun = false, started = false, settled = false
	let targets: { tabs: string[]; sessions: string[] } | undefined
	let text = ''
	let end = (code: number) => { if (!settled) { settled = true; finish(code) } }
	let fail = (why: string, code = 1) => { io.err(`hal: ${why}\n`); end(code) }
	let submit = () => {
		promptId = connection.nextId()
		connection.send({ type: 'submit', sessionId: session, text: job.prompt, id: promptId, delivery: job.delivery ?? 'soft-steer' })
	}
	let opened = () => {
		if (!job.model) return submit()
		modelId = connection.nextId()
		connection.send({ type: 'submit', sessionId: session, text: `/model ${job.model}`, id: modelId })
	}
	let target = () => {
		if (!begun || !targets || session || settled) return
		let value = job.session!
		let found = /^\d+$/.test(value) ? targets.tabs[Number(value) - 1] : targets.sessions.includes(value) ? value : undefined
		if (!found) return fail(`no session ${value}`, 2)
		session = found
		id = connection.nextId()
		connection.send({ type: 'open', sessionId: session, id })
	}
	let begin = () => {
		begun = true
		if (job.session) return target()
		id = connection.nextId()
		connection.send({ type: 'tab-new', cwd: job.cwd, autoclose: !job.keep, id })
	}
	let onEvent = (e: Event) => {
		if (settled) return
		if (e.type === 'tabs') {
			targets = { tabs: e.tabs.map((t) => t.id), sessions: e.sessions ?? targets?.sessions ?? e.tabs.map((t) => t.id) }
			if (job.session) target()
			return
		}
		if (e.type === 'warning') return io.err(`hal: ${e.text}\n`)
		if (e.type === 'rejected' && e.id !== undefined && [id, modelId, promptId].includes(e.id)) return fail(e.reason, e.id === id && job.session ? 2 : 1)
		if (e.type === 'ack' && e.id === id && e.tab && !job.session) {
			session = e.tab
			connection.send({ type: 'open', sessionId: session })
			return opened()
		}
		if (!('sessionId' in e) || e.sessionId !== session) return
		if (e.type === 'snapshot' && job.session && !promptId && !modelId) return opened()
		if (e.type === 'output' && modelId && !promptId) {
			if (!e.error) return submit()
			if (!job.session) connection.send({ type: 'tab-close', sessionId: session })
			return fail(e.text)
		}
		// Exact ids handle batching without mistaking withdrawal for delivery.
		if ((e.type === 'turn-start' || e.type === 'prompt') && promptId && (e.command === promptId || e.inbox?.includes(promptId))) { started = true; text = '' }
		else if (!started) return
		else if (e.type === 'stream' && e.event.type === 'tool_call') text = ''
		else if (e.type === 'stream' && e.event.type === 'text' && !e.event.naming) text += e.event.text
		else if (e.type === 'question') io.err(`hal: waiting for an answer in Hal: ${e.form.text}\n`)
		else if (e.type === 'turn-end' && e.status === 'completed') {
			io.out(`${summary.answer(text).trim()}\n`)
			end(summary.asks(text) ? 3 : 0)
		} else if (e.type === 'turn-end') fail(`turn ${e.status}${e.error ? `: ${e.error}` : ''}`)
	}
	return { onEvent, begin, done }
}

export const print = { run }
