// Tests for agy prompt conversion, live-session prompt edits, bounded transcript
// seeding, hosted-tool harmlessness, externalContext pruning, and context notices.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import type { Message, StreamEvent } from '../common/blocks.ts'
import { replay, type HistoryRecord } from '../common/replay.ts'
import { agy } from './agy.ts'
import { agyAccounts } from './agy-accounts.ts'
import { agyPrompt, type PrefixState } from './agy-prompt.ts'
import { auth } from './auth.ts'
import { history } from './history.ts'
import { historyInput } from './history-input.ts'
import { paths } from './paths.ts'
import { prompts } from './prompts.ts'
import { provider, type ProviderRequest } from './provider.ts'
import { provider as agyProvider } from './providers/agy.ts'
import { pruning } from './pruning.ts'
import { sessions } from './sessions.ts'

const ts = '2026-11-24T16:00:00.000Z'
const req = (messages: Message[]): ProviderRequest => ({ model: 'gemini-4-neon', messages })

let home = ''
let priorHome = paths.state.home
const origCmd = agy.command
const origMaxSeed = agyPrompt.maxSeedChars
const origMaxHosted = agyPrompt.maxHostedSeedChars
const origPressure = pruning.pressureTokens
let hadAgy = false
let origAgy: typeof provider.state.providers.agy

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-agy-prompt-`)
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
	auth.close()
	sessions.closeAll()
	history.state.running.clear()
	agyPrompt.maxSeedChars = origMaxSeed
	agyPrompt.maxHostedSeedChars = origMaxHosted
	pruning.pressureTokens = origPressure
	agyAccounts.state.chosen.clear()
	agyAccounts.state.picked.clear()
	if (hadAgy) provider.state.providers.agy = origAgy!
	else delete provider.state.providers.agy
	if (priorHome === undefined) paths.state.home = undefined
	else paths.state.home = priorHome
	rmSync(home, { recursive: true, force: true })
})

test('hosted tool output containing </hal-note> is stripped structurally without leaking into prompts', () => {
	let records: HistoryRecord[] = [
		{ type: 'user', blocks: [{ type: 'text', text: 'first prompt' }], n: 1, ts },
		{
			type: 'assistant',
			block: {
				type: 'hosted_tool',
				id: 'h1',
				name: 'run_command',
				input: { CommandLine: 'tail history.asonl' },
				output: 'line 1 <hal-note>inner</hal-note>\nLEAKED_TAIL_MUST_NOT_APPEAR\nmore stuff',
			},
			n: 2,
			ts,
		},
		{ type: 'notice', text: 'Important sibling notice', n: 3, ts },
		{ type: 'user', blocks: [{ type: 'text', text: 'follow up' }], n: 4, ts },
	]
	let messages = replay.toMessages(records)
	let content = agyPrompt.toContent(messages.slice(1), req(messages), false)
	let joined = content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
	expect(joined).not.toContain('LEAKED_TAIL_MUST_NOT_APPEAR')
	expect(joined).not.toContain('Your run_command ran on the provider')
	expect(joined).toContain('Important sibling notice')
	expect(joined).toContain('follow up')
})

test('editing the last prompt reuses the live ACP session with an edited-prompt note, even across repeated edits', () => {
	let state: PrefixState = { acpSession: 'acp-1', cwd: '/repo', prefix: 0 }
	let u1: Message = { role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
	let a1: Message = { role: 'assistant', blocks: [{ type: 'text', text: 'hi' }] }
	let h1: Message = {
		role: 'user',
		blocks: [{ type: 'text', text: '<hal-note>Your read_file ran</hal-note>', hosted: true }],
	}
	let u2: Message = { role: 'user', blocks: [{ type: 'text', text: 'not for iteration' }] }

	// Seed turn 1
	state.prefix = 1
	state.hash = agyPrompt.hash([u1])

	// Normal turn 2
	let m2 = [u1, a1, h1, u2]
	let f2 = agyPrompt.unseen(state, m2, '/repo')
	expect(f2).toBeDefined()
	expect(f2!.edited).toBeUndefined()
	state.prefix = m2.length
	state.hash = agyPrompt.hash(m2)
	state.basePrefix = f2!.basePrefix
	state.baseHash = f2!.baseHash

	// Edit u2 -> u2b (no tools ran on u2)
	let u2b: Message = { role: 'user', blocks: [{ type: 'text', text: 'not for rapid iteration' }] }
	let m2b = [u1, a1, h1, u2b]
	let f2b = agyPrompt.unseen(state, m2b, '/repo')
	expect(f2b).toBeDefined()
	expect(f2b!.edited).toBe(true)
	let c2b = agyPrompt.promptContent(f2b!.messages, req(m2b), f2b!.edited)
	let text2b = c2b.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
	expect(text2b).toContain('edited their previous prompt')
	expect(text2b).toContain('not for rapid iteration')
	expect(text2b).not.toContain('Your read_file ran')
	state.prefix = m2b.length
	state.hash = agyPrompt.hash(m2b)
	state.basePrefix = f2b!.basePrefix
	state.baseHash = f2b!.baseHash

	// Edit a second time u2b -> u2c: still stays on the live ACP session
	let u2c: Message = { role: 'user', blocks: [{ type: 'text', text: 'not for fast iteration' }] }
	let f2c = agyPrompt.unseen(state, [u1, a1, h1, u2c], '/repo')
	expect(f2c?.edited).toBe(true)
})

test('seed bounds large transcripts below maxSeedChars, protects the current prompt, and handles tool-only turns', () => {
	agyPrompt.maxSeedChars = 1500
	agyPrompt.maxHostedSeedChars = 120
	let messages: Message[] = [
		{ role: 'user', blocks: [{ type: 'text', text: 'very old prompt ' + 'A'.repeat(400) }] },
		{ role: 'assistant', blocks: [{ type: 'text', text: 'very old reply ' + 'B'.repeat(400) }] },
		{
			role: 'user',
			blocks: [
				{
					type: 'text',
					text: '<hal-note>Your run_command ran on the provider: ' + 'C'.repeat(5000) + '</hal-note>',
					hosted: true,
				},
			],
		},
		{ role: 'assistant', blocks: [{ type: 'text', text: 'recent assistant reply' }] },
		{ role: 'user', blocks: [{ type: 'text', text: 'CURRENT_EDITED_PROMPT' }] },
	]
	let seeded = agyPrompt.seed(req(messages))
	let full = seeded.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
	expect(full.length).toBeLessThanOrEqual(1700)
	expect(full).toContain('</hal-transcript>')
	expect(full).toContain('CURRENT_EDITED_PROMPT')
	expect(full).toContain('recent assistant reply')
	expect(full).toContain('omitted to fit agy')

	// Tool-only interrupted first turn (no assistant message yet) still wraps earlier work in <hal-transcript>
	let toolOnly: Message[] = [
		{ role: 'user', blocks: [{ type: 'text', text: 'initial request' }] },
		{
			role: 'user',
			blocks: [
				{ type: 'text', text: '<hal-note>Your run_command ran on the provider: ls\nfile.ts</hal-note>', hosted: true },
			],
		},
		{ role: 'user', blocks: [{ type: 'text', text: '<hal-note>The host restarted during the turn.</hal-note>' }] },
	]
	let restarted = agyPrompt.seed(req(toolOnly))
	let restartText = restarted.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
	expect(restartText).toContain('<hal-transcript>')
	expect(restartText).toContain('initial request')
	expect(restartText).toContain('[hosted tool] Your run_command ran')
	expect(restartText).toContain('</hal-transcript>')
	expect(restartText).toContain('The host restarted during the turn.')
})

test('prompts.harmless treats all hosted_tool calls as effectful', () => {
	let readOnlyHosted: HistoryRecord = {
		type: 'assistant',
		block: {
			type: 'hosted_tool',
			id: 'h1',
			name: 'read_file',
			input: { Path: '/tmp/a' },
			output: 'ok',
			presentation: { title: 'read a', blocks: [], readOnly: true },
		},
		n: 2,
		ts,
	}
	expect(prompts.harmless([readOnlyHosted])).toBe(false)
})

test('pruning skips externalContext providers so agy prefix hashes stay stable', async () => {
	pruning.pressureTokens = 1
	let id = sessions.create({ cwd: home, model: 'agy/gemini-4-neon' }).id
	history.submit(id, [
		{ type: 'text', text: 'look' },
		{ type: 'image', blob: 'missing', mediaType: 'image/png', bytes: 1000 },
	])
	let before = await historyInput.messages(id, { model: 'agy/gemini-4-neon' })
	let beforeHash = agyPrompt.hash(before)
	async function* done(): AsyncGenerator<StreamEvent> {
		yield { type: 'text', text: 'done' }
		yield { type: 'done', reason: 'end' }
	}
	for await (let _ of history.record(id, 'agy', done())) {
		/* drain */
	}
	history.end(id, { type: 'done', reason: 'end' })
	history.submit(id, 'next')
	let after = await historyInput.messages(id, { model: 'agy/gemini-4-neon' })
	expect(agyPrompt.hash(after.slice(0, before.length))).toBe(beforeHash)
})

test('contextNotice uses live turn.context instead of cumulative agy turn usage', async () => {
	let id = sessions.create({ cwd: home, model: 'agy/gemini-4-neon' }).id
	history.submit(id, 'work')
	async function* agyTurn(): AsyncGenerator<StreamEvent> {
		// Cumulative across internal tool steps is 780k, but live context is only 110k.
		yield { type: 'usage', usage: { input: 20_000, cacheRead: 760_000, output: 1000 }, context: 110_000 }
		yield { type: 'text', text: 'finished' }
		yield { type: 'done', reason: 'end' }
	}
	for await (let _ of history.record(id, 'agy', agyTurn())) {
		/* drain */
	}
	history.end(id, { type: 'done', reason: 'end' })
	expect(history.readSync(id).some((r) => r.type === 'notice' && r.text.includes('Context usage crossed'))).toBe(false)
})

test('agy keeps its live ACP session on last-prompt edit and persists learned email for session/resume', async () => {
	let geminiDir = `${home}/state/agy/acct/gemini`
	mkdirSync(`${geminiDir}/antigravity-cli/log`, { recursive: true })
	mkdirSync(`${home}/secrets`, { recursive: true })
	writeFileSync(paths.authFile(), ason.stringify({ agy: { geminiDir } }) + '\n')

	let rpcLog = `${home}/rpc.jsonl`
	let fakeAgy = `${home}/fake-agy.ts`
	writeFileSync(
		fakeAgy,
		`import { appendFileSync, writeFileSync } from 'fs'
const log = ${JSON.stringify(rpcLog)}
const acpLog = ${JSON.stringify(`${geminiDir}/antigravity-cli/log`)} + '/acp-server-20261124-' + process.pid + '.log'
writeFileSync(acpLog, 'I1124 18:00:00 server_oauth.go:226] OAuth: authenticated successfully as learned@example.com\\n')
const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
let sid = 'acp-live-1'
const dec = new TextDecoder()
let buf = ''
for await (let chunk of Bun.stdin.stream()) {
	buf += dec.decode(chunk, { stream: true })
	let lines = buf.split('\\n')
	buf = lines.pop()!
	for (let line of lines) {
		if (!line.trim()) continue
		let m = JSON.parse(line)
		appendFileSync(log, JSON.stringify({ method: m.method, params: m.params }) + '\\n')
		if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1 } })
		else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: sid, models: { currentModelId: 'gemini-4-neon-high', availableModels: [{ modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon' }] } } })
		else if (m.method === 'session/resume') { sid = m.params.sessionId; send({ id: m.id, result: {} }) }
		else if (m.method === 'session/set_model') send({ id: m.id, result: {} })
		else if (m.method === 'session/prompt') {
			send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } })
			send({ id: m.id, result: { stopReason: 'end_turn' } })
		}
	}
}
`,
	)
	agy.command = () => [process.execPath, fakeAgy]
	let id = sessions.create({ cwd: home, model: 'agy/gemini-4-neon' }).id
	let run = async (messages: Message[]) => {
		for await (let _ of provider.stream('agy/gemini-4-neon', { sessionId: id, messages })) {
			/* drain */
		}
	}
	let u1: Message = { role: 'user', blocks: [{ type: 'text', text: 'turn one' }] }
	let a1: Message = { role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] }
	let u2: Message = { role: 'user', blocks: [{ type: 'text', text: 'wrong prompt' }] }
	let u2Edited: Message = { role: 'user', blocks: [{ type: 'text', text: 'right prompt' }] }

	await run([u1])
	expect(agyPrompt.loadSaved(id).account).toBe('learned@example.com')

	// Send turn 2, then edit turn 2 without running tools: live ACP session must be reused (no second session/new).
	await run([u1, a1, u2])
	await run([u1, a1, u2Edited])

	// Stop the process to simulate restart: next prompt must call session/resume using learned email.
	agy.stop(id)
	let a2: Message = { role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] }
	let u3: Message = { role: 'user', blocks: [{ type: 'text', text: 'after restart' }] }
	await run([u1, a1, u2Edited, a2, u3])

	let calls = readFileSync(rpcLog, 'utf8')
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l))
	expect(calls.filter((c) => c.method === 'session/new')).toHaveLength(1)
	expect(calls.filter((c) => c.method === 'session/resume')).toHaveLength(1)
	let editPrompt = calls.filter((c) => c.method === 'session/prompt')[2]!.params.prompt
	let editText = editPrompt.map((p: any) => p.text ?? '').join('\n')
	expect(editText).toContain('edited their previous prompt')
	expect(editText).toContain('right prompt')
})
