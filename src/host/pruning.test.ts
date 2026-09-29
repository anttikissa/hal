import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import type { Message, StreamEvent } from '../common/blocks.ts'
import { history } from './history.ts'
import { sessions } from './sessions.ts'
import { pruning } from './pruning.ts'
import { tools } from './tools.ts'
import { anthropic } from './anthropic.ts'

let home = ''
let priorHome = process.env.HAL_HOME
const oldPressure = pruning.pressureTokens
beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-pruning-`)
	process.env.HAL_HOME = home
})
afterEach(() => {
	sessions.closeAll()
	history.state.running.clear()
	pruning.pressureTokens = oldPressure
	if (priorHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = priorHome
	rmSync(home, { recursive: true, force: true })
})
async function round(id: string, events: StreamEvent[]) {
	async function* stream() { yield* events }
	for await (let _event of history.record(id, 'anthropic', stream())) { /* drain */ }
}
const providerBytes = (messages: Message[]) => anthropic.toMessages({ model: 'test', messages }).map((m) => JSON.stringify(m))


test('provider prefix is byte-identical through many rounds, turns, retries and reopen; only checkpoints rewrite it', async () => {
	pruning.pressureTokens = () => Infinity
	let id = sessions.create({ cwd: home, model: 'anthropic/test' }).id
	let frozen: string[] = []
	let boundaries = 0
	for (let turn = 0; turn < 26; turn++) {
		history.submit(id, `instructions ${turn}`)
		let initial = await history.messages(id)
		let bytes = providerBytes(initial)
		if (turn > 0 && turn % 8 === 0) {
			expect(bytes.join('')).not.toContain(`payload ${turn - 8}/0 `)
			boundaries++
		} else expect(bytes.slice(0, frozen.length)).toEqual(frozen)
		// Freeze complete messages, not the newest tail whose blocks can append.
		frozen = bytes.slice(0, -1)
		for (let toolRound = 0; toolRound < 12; toolRound++) {
			let call = `${turn}/${toolRound}`
			let input = { command: `printf '${call}'`, path: 'src/file.ts', long: 'a'.repeat(2000) }
			await round(id, [{ type: 'thinking', text: 'signed thought' }, { type: 'signature', value: 'signature' }, { type: 'tool_call', id: call, name: 'bash', input }, { type: 'done', reason: 'tool_use' }])
			history.results(id, [{ type: 'tool_result', id: call, output: `payload ${call} ` + 'x'.repeat(5000) }])
			let messages = await history.messages(id)
			let fresh = messages.at(-1)!.blocks.find((b) => b.type === 'tool_result')
			expect(fresh?.type === 'tool_result' && fresh.output).toContain(`payload ${call} `)
			expect(providerBytes(messages).slice(0, frozen.length)).toEqual(frozen)
			expect(await history.messages(id)).toEqual(messages) // unchanged-history retry
		}
		await round(id, [{ type: 'text', text: 'answer' }, { type: 'done', reason: 'end' }])
		history.end(id, { type: 'done', reason: 'end' })
		// The new completed checkpoint is an allowed boundary.
		let messages = await history.messages(id)
		let calls = messages.flatMap((m) => m.blocks as unknown[]).filter((b: any) => b.type === 'tool_call') as any[]
		expect(calls[0].input.command).toBe("printf '0/0'")
		expect(calls[0].input.path).toBe('src/file.ts')
		if (turn >= 7) expect(calls[0].input.long).toContain('read_blob')
		frozen = providerBytes(messages).slice(0, -1)
		history.state.cache.clear()
		expect(providerBytes(await history.messages(id))).toEqual(providerBytes(messages))
	}
	expect(boundaries).toBe(3)
	expect(readFileSync(history.file(id), 'utf8')).toContain('payload 0/0 ')
}, 30_000)

test('pressure omits only consumed work durably; original/capped recovery and copied-marker safety', async () => {
	let id = sessions.create({ cwd: home, model: 'anthropic/test' }).id
	let ctx = { cwd: home, sessionId: id, signal: new AbortController().signal }
	history.submit(id, 'keep my instructions')
	await round(id, [{ type: 'tool_call', id: 'a', name: 'bash', input: { command: 'echo safe' } }, { type: 'done', reason: 'tool_use' }])
	let whole = 'first\n' + 'retained whole output\n'.repeat(4000)
	let capped = tools.cap(whole, id)
	let result = history.results(id, [{ type: 'tool_result', id: 'a', output: capped }])!
	pruning.pressureTokens = () => 1
	let protectedInput = await history.messages(id)
	expect(JSON.stringify(protectedInput)).toContain('whole output in blob')
	await round(id, [{ type: 'error', message: 'failed request' }])
	expect(await history.messages(id)).toEqual(protectedInput)
	await round(id, [{ type: 'text', text: 'read it' }, { type: 'done', reason: 'end' }])
	let pruned = await history.messages(id)
	let marker = pruned.flatMap((m) => m.blocks as unknown[]).find((b: any) => b.type === 'tool_result') as any
	expect(marker.output).toContain('[pruned tool output;')
	let blob = /id=([^\]]+)/.exec(marker.output)![1]
	let recovered = await tools.run({ type: 'tool_call', id: 'r', name: 'read_blob', input: { id: blob, limit: 2 } }, ctx)
	expect(recovered.output).toContain('first\nretained whole output\n')
	let original = await tools.run({ type: 'tool_call', id: 'r2', name: 'read_blob', input: { id: `${id}#${result.n}` } }, ctx)
	expect(original.output).toContain('first\nretained whole output\n')
	let tail = await tools.run({ type: 'tool_call', id: 'r3', name: 'read_blob', input: { id: `${id}#${result.n}`, charOffset: capped.indexOf('[cut:') + 1 } }, ctx)
	expect(tail.output).toContain('whole output in blob')
	let rejected = await tools.run({ type: 'tool_call', id: 'bad', name: 'bash', input: { command: `printf '%s' '${marker.output}' > should-not-exist` } }, ctx)
	expect(rejected.isError).toBe(true)
	expect(rejected.output).toContain('actual value')
	expect(existsSync(`${home}/should-not-exist`)).toBe(false)
	// Still over pressure: newly consumed results cannot slide this boundary.
	await round(id, [{ type: 'tool_call', id: 'b', name: 'read_blob', input: { id: blob } }, { type: 'done', reason: 'tool_use' }])
	history.results(id, [{ type: 'tool_result', id: 'b', output: 'fresh recovery '.repeat(1000) }])
	let fresh = await history.messages(id)
	await round(id, [{ type: 'text', text: 'consumed' }, { type: 'done', reason: 'end' }])
	expect(JSON.stringify(await history.messages(id))).toContain('fresh recovery ')
	expect(providerBytes(await history.messages(id)).slice(0, providerBytes(fresh).length - 1)).toEqual(providerBytes(fresh).slice(0, -1))
})
