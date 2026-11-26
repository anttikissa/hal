// Tests for agy permission-wait steering, open approval popups, prefix rollback
// on rejected prompts, and canceling background prompts after failed steers.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import type { Message, StreamEvent } from '../common/blocks.ts'
import { agy } from './agy.ts'
import { agyAccounts } from './agy-accounts.ts'
import { agyApproval } from './agy-approval.ts'
import { auth } from './auth.ts'
import { history } from './history.ts'
import { jobs } from './jobs.ts'
import { paths } from './paths.ts'
import { provider } from './provider.ts'
import { provider as agyProvider } from './providers/agy.ts'
import { sessions } from './sessions.ts'

let home = ''
let priorHome = paths.state.home
const origCmd = agy.command
const origRetryDelays = agyApproval.retryDelaysMs
let hadAgy = false
let origAgy: typeof provider.state.providers.agy

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-agy-approval-`)
	paths.state.home = home
	hadAgy = Object.hasOwn(provider.state.providers, 'agy')
	origAgy = provider.state.providers.agy
	provider.state.providers.agy = agyProvider
	agyAccounts.state.chosen.clear()
	agyAccounts.state.picked.clear()
})

afterEach(() => {
	agy.stopAll()
	agy.command = origCmd
	agyApproval.retryDelaysMs = origRetryDelays
	auth.close()
	sessions.closeAll()
	history.state.running.clear()
	agyAccounts.state.chosen.clear()
	agyAccounts.state.picked.clear()
	if (hadAgy) provider.state.providers.agy = origAgy!
	else delete provider.state.providers.agy
	if (priorHome === undefined) paths.state.home = undefined
	else paths.state.home = priorHome
	rmSync(home, { recursive: true, force: true })
})

function readRpcLog(path: string): any[] {
	try {
		return readFileSync(path, 'utf8')
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l))
	} catch {
		return []
	}
}

async function until(fn: () => boolean): Promise<void> {
	for (let i = 0; i < 100 && !fn(); i++) await Bun.sleep(10)
	expect(fn()).toBe(true)
}

async function drain(sessionId: string, messages: Message[], signal?: AbortSignal): Promise<StreamEvent[]> {
	let events: StreamEvent[] = []
	for await (let e of provider.stream('agy/gemini-4-neon', { sessionId, messages }, signal)) events.push(e)
	return events
}

test('agy retries steering prompts through silent-approval races and waits on open approval popups', async () => {
	agyApproval.retryDelaysMs = [10, 10, 10]
	mkdirSync(`${home}/secrets`, { recursive: true })
	writeFileSync(paths.authFile(), ason.stringify({ agy: { email: 't@example.com', keychain: true } }) + '\n')

	let rpcLog = `${home}/rpc-perm.jsonl`
	let fakeAgy = `${home}/fake-agy-perm.ts`
	writeFileSync(
		fakeAgy,
		`import { appendFileSync } from 'fs'
const log = ${JSON.stringify(rpcLog)}
const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
const waitErr = (id: number) => send({ id, error: { code: -32603, message: "Can't add this prompt to session acp-perm: the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again" } })
let pendingPrompts: number[] = []
let raceRejected = false
let waitingPopup = false
const dec = new TextDecoder()
let buf = ''
for await (let chunk of Bun.stdin.stream()) {
	buf += dec.decode(chunk, { stream: true })
	let lines = buf.split('\\n')
	buf = lines.pop()!
	for (let line of lines) {
		if (!line.trim()) continue
		let m = JSON.parse(line)
		appendFileSync(log, JSON.stringify({ method: m.method ?? 'reply', id: m.id, params: m.params, result: m.result }) + '\\n')
		if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1 } })
		else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'acp-perm', models: { currentModelId: 'gemini-4-neon' } } })
		else if (m.method === 'session/set_model') send({ id: m.id, result: {} })
		else if (m.method === 'session/prompt') {
			let text = (m.params.prompt ?? []).map((p: any) => p.text ?? '').join('\\n')
			if (text.includes('start')) {
				pendingPrompts.push(m.id)
				send({ id: 101, method: 'session/request_permission', params: { sessionId: 'acp-perm', toolCall: { name: 'run_command', rawInput: { CommandLine: 'ls' } }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } })
			} else if (text.includes('steer race') && !raceRejected) {
				raceRejected = true
				waitErr(m.id)
			} else if (text.includes('steer race')) {
				pendingPrompts.push(m.id)
				waitingPopup = true
				send({ id: 102, method: 'session/request_permission', params: { sessionId: 'acp-perm', toolCall: { name: 'run_command', rawInput: { CommandLine: 'rm -rf /some-dir' } }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } })
			} else if (text.includes('after popup')) {
				if (waitingPopup) waitErr(m.id)
				else {
					pendingPrompts.push(m.id)
					send({ method: 'session/update', params: { sessionId: 'acp-perm', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } })
					for (let pid of pendingPrompts.splice(0)) send({ id: pid, result: { stopReason: 'end_turn' } })
				}
			}
		} else if (m.id === 102) {
			waitingPopup = false
		}
	}
}
`,
	)
	agy.command = () => [process.execPath, fakeAgy]
	let id = sessions.create({ cwd: home, model: 'agy/gemini-4-neon', projectTrust: 'allow' }).id
	let u1: Message = { role: 'user', blocks: [{ type: 'text', text: 'start' }] }
	let u2: Message = { role: 'user', blocks: [{ type: 'text', text: 'steer race' }] }
	let u3: Message = { role: 'user', blocks: [{ type: 'text', text: 'after popup' }] }

	let c1 = new AbortController()
	let p1 = drain(id, [u1], c1.signal)
	await until(() => readRpcLog(rpcLog).some((r) => r.method === 'reply' && r.id === 101))

	// Steer 1 hits a one-shot -32603 race, retries cleanly, and opens a dangerous-command approval popup.
	c1.abort(jobs.steered)
	let c2 = new AbortController()
	let p2 = drain(id, [u1, u2], c2.signal)
	await until(() => [...agyApproval.state.pending.values()].some((p) => p.sessionId === id))

	// Steer 2 arrives while the popup is open: held until the user answers, then permission reply goes first.
	c2.abort(jobs.steered)
	let c3 = new AbortController()
	let p3 = drain(id, [u1, u2, u3], c3.signal)
	await Bun.sleep(40)
	expect(
		readRpcLog(rpcLog).some((r) => r.method === 'session/prompt' && JSON.stringify(r.params).includes('after popup')),
	).toBe(false)

	let [reqId] = [...agyApproval.state.pending.entries()].find(([, p]) => p.sessionId === id)!
	expect(agyApproval.answer(reqId, { run: 'Allow' })).toEqual({})

	let [, , e3] = await Promise.all([p1, p2, p3])
	expect(e3.some((e) => e.type === 'done')).toBe(true)
	let log = readRpcLog(rpcLog)
	expect(log.some((r) => r.method === 'session/cancel')).toBe(false)
	let replyIdx = log.findIndex((r) => r.method === 'reply' && r.id === 102)
	let promptIdx = log.findIndex(
		(r) => r.method === 'session/prompt' && JSON.stringify(r.params).includes('after popup'),
	)
	expect(replyIdx).toBeGreaterThan(-1)
	expect(promptIdx).toBeGreaterThan(replyIdx)
})

test('agy unrecoverable steer rejection rolls back prefix, cancels background prompt, and refuses late approvals', async () => {
	agyApproval.retryDelaysMs = [5, 5]
	mkdirSync(`${home}/secrets`, { recursive: true })
	writeFileSync(paths.authFile(), ason.stringify({ agy: { email: 't@example.com', keychain: true } }) + '\n')

	let rpcLog = `${home}/rpc-fail.jsonl`
	let fakeAgy = `${home}/fake-agy-fail.ts`
	writeFileSync(
		fakeAgy,
		`import { appendFileSync } from 'fs'
const log = ${JSON.stringify(rpcLog)}
const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
let blocked = true
let pending: number[] = []
const dec = new TextDecoder()
let buf = ''
for await (let chunk of Bun.stdin.stream()) {
	buf += dec.decode(chunk, { stream: true })
	let lines = buf.split('\\n')
	buf = lines.pop()!
	for (let line of lines) {
		if (!line.trim()) continue
		let m = JSON.parse(line)
		appendFileSync(log, JSON.stringify({ method: m.method ?? 'reply', id: m.id, params: m.params, result: m.result }) + '\\n')
		if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1 } })
		else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'acp-fail', models: { currentModelId: 'gemini-4-neon' } } })
		else if (m.method === 'session/set_model') send({ id: m.id, result: {} })
		else if (m.method === 'session/cancel') {
			blocked = false
			for (let pid of pending.splice(0)) send({ id: pid, result: { stopReason: 'cancelled' } })
			// Late permission after turn failure must be cancelled, never auto-approved.
			send({ id: 201, method: 'session/request_permission', params: { sessionId: 'acp-fail', toolCall: { name: 'run_command', rawInput: { CommandLine: 'ls' } }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } })
		} else if (m.method === 'session/prompt') {
			let text = (m.params.prompt ?? []).map((p: any) => p.text ?? '').join('\\n')
			if (text.includes('first')) pending.push(m.id)
			else if (blocked)
				send({ id: m.id, error: { code: -32603, message: "Can't add this prompt to session acp-fail: the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again" } })
			else {
				send({ method: 'session/update', params: { sessionId: 'acp-fail', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'recovered' } } } })
				send({ id: m.id, result: { stopReason: 'end_turn' } })
			}
		}
	}
}
`,
	)
	agy.command = () => [process.execPath, fakeAgy]
	let id = sessions.create({ cwd: home, model: 'agy/gemini-4-neon', projectTrust: 'allow' }).id
	let u1: Message = { role: 'user', blocks: [{ type: 'text', text: 'first' }] }
	let u2: Message = { role: 'user', blocks: [{ type: 'text', text: 'must survive retry' }] }
	let retryNotice: Message = { role: 'user', blocks: [{ type: 'text', text: '<hal-note>retry</hal-note>' }] }

	let c1 = new AbortController()
	let p1 = drain(id, [u1], c1.signal)
	await until(() => readRpcLog(rpcLog).some((r) => r.method === 'session/prompt'))

	c1.abort(jobs.steered)
	let e2 = await drain(id, [u1, u2])
	await p1
	expect(e2.some((e) => e.type === 'error' && e.message.includes('waiting for a permission'))).toBe(true)

	await until(() => readRpcLog(rpcLog).some((r) => r.method === 'reply' && r.id === 201))
	let logAfterFail = readRpcLog(rpcLog)
	expect(logAfterFail.some((r) => r.method === 'session/cancel')).toBe(true)
	expect(logAfterFail.find((r) => r.method === 'reply' && r.id === 201)?.result).toEqual({
		outcome: { outcome: 'cancelled' },
	})

	// Retry after error must resend 'must survive retry' because prefix rolled back on rejection.
	let e3 = await drain(id, [u1, u2, retryNotice])
	expect(e3.some((e) => e.type === 'done')).toBe(true)
	let promptsSent = readRpcLog(rpcLog).filter((r) => r.method === 'session/prompt')
	expect(JSON.stringify(promptsSent.at(-1)!.params)).toContain('must survive retry')
})
