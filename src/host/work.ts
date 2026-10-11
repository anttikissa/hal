import type { ToolCallBlock } from '../common/blocks.ts'
import { forms } from '../common/forms.ts'
import type { Event } from '../common/protocol.ts'
import { session } from '../common/session.ts'
import { states } from '../common/states.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { jobs } from './jobs.ts'
import { notify } from './notify.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'
import { slash } from './slash.ts'
import { subagents } from './subagents.ts'
import { toolOutput } from './tool-output.ts'
import { tools } from './tools.ts'
import { turns } from './turns.ts'

type Target = { sessionId: string; ref: string; n?: number; call?: ToolCallBlock }
type Listener = { ids: Set<string>; check: () => void; queued?: boolean }

function isTarget(value: unknown): boolean {
	return typeof value === 'number' || typeof value === 'string' && (session.isId(value) || /^#?t?\d+$/.test(value))
}

function target(self: string, value: unknown): Target {
	let ref = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : ''
	if (session.isId(ref)) { sessions.open(ref); return { sessionId: ref, ref } }
	let digits = /^#?t?(\d+)$/.exec(ref)?.[1]
	let n = digits === undefined ? NaN : Number(digits)
	if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid work target ${JSON.stringify(value)}; use a session ID or #t123, t123 or 123 (tool calls in this session, not tab numbers).`)
	let record = history.readSync(self).find((r) => r.n === n)
	if (record?.type !== 'assistant' || record.block.type !== 'tool_call' || record.originSession && record.originSession !== self) throw new Error(`#t${n} is not a local tool call in session ${self}.`)
	return { sessionId: self, ref: `#t${n}`, n, call: record.block }
}

function children(t: Target): Target[] {
	if (t.call && t.call.name !== 'spawn') return []
	return sessions.openIds().flatMap((id) => {
		let meta = sessions.open(id)
		if (meta.owner !== t.sessionId || meta.spawn === 'interactive' || t.n !== undefined && meta.ownerCall !== t.n) return []
		return [{ sessionId: id, ref: id }]
	})
}

function tree(t: Target, seen = new Set<string>()): Target[] {
	let key = `${t.sessionId}:${t.n ?? ''}`
	if (seen.has(key)) throw new Error(`Work ownership cycle at ${t.ref}.`)
	seen.add(key)
	return [t, ...work.children(t).flatMap((c) => work.tree(c, seen))]
}

function active(t: Target): boolean {
	if (!t.call) return states.busy(status.stateOf(t.sessionId)) || jobs.running(t.sessionId).length > 0
	return jobs.state.running.has(`${t.sessionId}:${t.n}`) || tools.running.has(`${t.sessionId}:${t.call.id}`) || work.children(t).some(work.active)
}

function attention(t: Target): boolean {
	if (!t.call) {
		let state = status.stateOf(t.sessionId)
		return !subagents.delivering.has(t.sessionId) && (!turns.state.running.has(t.sessionId) && !states.busy(state) || state.type === 'blocked' || notify.asked(t.sessionId))
	}
	return !jobs.state.delivering.has(`${t.sessionId}:${t.n}`) && !jobs.state.running.has(`${t.sessionId}:${t.n}`) && !tools.running.has(`${t.sessionId}:${t.call.id}`) && work.children(t).every(work.attention)
}

function defaults(self: string): Target[] {
	return [
		...[...new Set([...jobs.running(self), ...[...jobs.state.delivering.keys()].filter((id) => id.startsWith(`${self}:`))])].map((id) => work.target(self, jobs.label(self, id))),
		...work.children({ sessionId: self, ref: self }).filter((t) => work.active(t) || notify.asked(t.sessionId) || subagents.delivering.has(t.sessionId)),
	]
}

function changed(id: string, event: Event): void {
	if (!['state', 'turn-end', 'question', 'tool-results', 'inbox', 'meta'].includes(event.type)) return
	work.wake(id)
}

function wake(id: string): void {
	for (let listener of work.listeners) if (listener.ids.has(id) && !listener.queued) {
		listener.queued = true
		queueMicrotask(() => {
			listener.queued = false
			if (work.listeners.has(listener)) listener.check()
		})
	}
}

async function wait(targets: Target[], signal: AbortSignal): Promise<string> {
	if (!targets.length) return 'No owned background command or subagent is running. Go on without waiting.'
	return new Promise((resolve, reject) => {
		let finish = (text?: string, error?: unknown) => {
			work.listeners.delete(listener)
			signal.removeEventListener('abort', abort)
			if (error) reject(error)
			else resolve(text!)
		}
		let check = () => {
			try {
				let ready = targets.filter(work.attention)
				listener.ids = new Set(targets.flatMap((t) => work.tree(t).map((c) => c.sessionId)))
				if (ready.length) finish(`Work needs attention: ${ready.map((t) => t.ref).join(', ')}. Inspect the targets; available reports follow through their usual delivery.`)
			} catch (e) { finish(undefined, e) }
		}
		let abort = () => finish(undefined, new Error(jobs.why(signal, 'Wait stopped')))
		let listener = { ids: new Set(targets.flatMap((t) => work.tree(t).map((c) => c.sessionId))), check }
		work.listeners.add(listener)
		signal.addEventListener('abort', abort, { once: true })
		if (signal.aborted) abort()
		else check()
	})
}

function inspect(t: Target): string {
	let records = history.readSync(t.sessionId)
	let state = status.stateOf(t.sessionId)
	let output: string | undefined
	if (t.call) {
		let result = records.findLast((r) => r.type === 'user' && r.blocks.some((b) => b.type === 'tool_result' && b.id === t.call!.id))
		let block = result?.type === 'user' ? result.blocks.find((b) => b.type === 'tool_result' && b.id === t.call!.id) : undefined
		let message = status.inboxOf(t.sessionId).findLast((m) => m.label === `bash ${t.ref}`)
		let delivered = records.findLast((r) => r.type === 'user' && r.blocks.some((b) => b.type === 'text' && b.label === `bash ${t.ref}`))
		let text = delivered?.type === 'user' ? delivered.blocks.find((b) => b.type === 'text' && b.label === `bash ${t.ref}`) : undefined
		output = jobs.state.running.get(`${t.sessionId}:${t.n}`)?.output?.() ?? jobs.state.delivering.get(`${t.sessionId}:${t.n}`) ?? toolOutput.of(t.sessionId).find((p) => p.id === t.call!.id)?.output ?? message?.text ?? (text?.type === 'text' ? text.text : undefined) ?? (block?.type === 'tool_result' ? block.output : undefined)
	} else {
		let last = records.findLast((r) => r.type === 'assistant' && r.block.type === 'text')
		output = last?.type === 'assistant' && last.block.type === 'text' ? last.block.text : undefined
		if (state.type === 'error') output = `${state.message}\n${output ?? ''}`
	}
	let question = forms.open(records)
	return [
		`${t.ref}: ${t.call ? work.active(t) ? 'running' : 'not running' : state.type}${!t.call && state.type === 'running' ? ` (${state.phase})` : ''}`,
		t.call ? `${t.call.name.toUpperCase()}: ${String(t.call.input.description ?? t.call.input.command ?? '')}` : `Name: ${sessions.open(t.sessionId).name ?? t.sessionId}`,
		...work.children(t).map((c) => t.call ? work.inspect(c) : `Owned session: ${c.ref} (${status.stateOf(c.sessionId).type})`),
		...(!t.call ? jobs.running(t.sessionId).map((id) => `Background command: ${jobs.label(t.sessionId, id)}`) : []),
		...(question ? [`Pending question: ${question.form.text}`] : []),
		...(output ? [`${!t.call && notify.asked(t.sessionId) ? 'Pending question' : 'Output'}:\n${output}`] : []),
	].join('\n')
}

function stop(t: Target): string {
	let targets = work.tree(t)
	let unsafe = targets.flatMap((at) => [
		...jobs.running(at.sessionId).filter((id) => (at.n === undefined || id === `${at.sessionId}:${at.n}`) && jobs.state.running.get(id)?.unsafe).map((id) => `${at.sessionId} ${jobs.label(at.sessionId, id)}`),
		...[...tools.running.values()].filter((r) => tools.unsafe(r.call) && tools.running.get(`${at.sessionId}:${r.call.id}`) === r && (at.n === undefined || r.call.id === at.call?.id)).map((r) => `${at.sessionId} ${r.call.id}`),
	])
	let lines: string[] = unsafe.length ? [`Warning: stopping unsafe-to-stop work (${unsafe.join(', ')}) may leave broken state.`] : []
	for (let at of targets) {
		try {
			let stopped = false
			if (!at.call) for (let [key, running] of tools.running) if (key.startsWith(`${at.sessionId}:`) && !['bash', 'wait', 'stop', 'spawn'].includes(running.call.name)) {
				let record = history.readSync(at.sessionId).findLast((r) => r.type === 'assistant' && r.block.type === 'tool_call' && r.block.id === running.call.id)
				lines.push(`Warning: ${at.sessionId} #t${record?.n} (${running.call.name.toUpperCase()}) has no individual STOP support and may still finish after the agent stops.`)
			}
			if (!at.call && states.busy(status.stateOf(at.sessionId))) {
				let refused = turns.stop(at.sessionId, 'stopped recursively', true)
				if (refused) throw new Error(refused)
				stopped = true
			}
			let ids = jobs.running(at.sessionId).filter((id) => at.n === undefined || id === `${at.sessionId}:${at.n}`)
			for (let id of ids) {
				let result = jobs.stop(at.sessionId, jobs.label(at.sessionId, id))
				if (result.refused) throw new Error(result.refused)
				lines.push(`Stopped ${at.sessionId} ${result.stopped}.`)
				stopped = true
			}
			if (at.call && !ids.length) {
				let running = tools.running.get(`${at.sessionId}:${at.call.id}`)
				if (running) {
					if (!['bash', 'wait'].includes(at.call.name)) throw new Error(`running ${at.call.name.toUpperCase()} cannot be interrupted individually; stop session ${at.sessionId} instead`)
					running.controller.abort()
					stopped = true
				}
			}
			if (!at.call && !states.busy(status.stateOf(at.sessionId)) && status.stateOf(at.sessionId).type !== 'paused' && (stopped || work.tree(at).some((c) => work.active(c) || notify.asked(c.sessionId)))) {
				let state = { type: 'paused' as const, reason: 'stopped recursively' }
				history.append(at.sessionId, { type: 'turn_end', status: 'paused', pauseReason: state.reason, usage: {} })
				status.state.states.set(at.sessionId, state)
				host.broadcast(at.sessionId, { type: 'state', sessionId: at.sessionId, state })
				slash.output(at.sessionId, 'Stopped recursively; session retained.')
			}
			lines.push(`${stopped ? 'Stopped' : 'Already not running'} ${at.ref}.`)
		} catch (e) { lines.push(`Could not stop ${at.ref}: ${e instanceof Error ? e.message : String(e)}`) }
	}
	let text = `${lines.join('\n')}\nSessions and output are retained. Stopping does not undo external effects.`
	if (lines.some((line) => line.startsWith('Could not stop'))) throw new Error(text)
	return text
}

function survivors(self: string): string | undefined {
	let targets = work.defaults(self)
	if (!targets.length) return undefined
	return [
		`${status.stateOf(self).type === 'paused' ? 'Turn paused.' : 'No current turn to pause.'} Still running or needing attention:`,
		...targets.map((t) => {
			let description = t.call ? String(t.call.input.description ?? t.call.input.command ?? t.call.name) : sessions.open(t.sessionId).name ?? t.ref
			return `  ${t.ref}: ${description.replace(/\s+/g, ' ').trim()}${t.call?.input.unsafeToStop ? ' (unsafe to stop)' : ''}`
		}),
		...(targets.some((t) => t.call) ? [`Stop one background command: /kill ${targets.find((t) => t.call)!.ref}. Stop all background commands here: /kill all.`] : []),
		`Stop a session and its owned work recursively: /stop <session-id>. Stop this whole tree: /stop ${self}.`,
	].join('\n')
}

function pause(self: string): string | undefined {
	let refused = turns.stop(self)
	let text = work.survivors(self)
	if (text) slash.output(self, text)
	return text ? undefined : refused
}

export const work = { listeners: new Set<Listener>(), isTarget, target, children, tree, active, attention, defaults, changed, wake, wait, inspect, stop, survivors, pause }
