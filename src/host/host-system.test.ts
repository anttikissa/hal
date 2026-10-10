import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import type { Message, StreamEvent } from '../common/blocks.ts'
import type { Event } from '../common/protocol.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { slash } from './slash.ts'
import { turns } from './turns.ts'
import { liveFiles } from './live-file.ts'
import type { ProviderRequest } from './provider.ts'
import { sessions } from './sessions.ts'
import { until } from './host-fixture.test.ts'

const savedHome = process.env.HAL_HOME
const origOnError = liveFiles.onError
const origStream = turns.stream
let home = ''
let work = ''
let requests: Omit<ProviderRequest, 'model'>[] = []

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-system-host-`)
	work = `${home}/work`
	mkdirSync(`${work}/sub`, { recursive: true })
	writeFileSync(`${work}/AGENTS.md`, 'WORK RULE')
	writeFileSync(`${work}/sub/AGENTS.md`, 'SUB RULE')
	process.env.HAL_HOME = home
	liveFiles.onError = () => {}
	requests = []
	turns.stream = (_model, input) => {
		requests.push(input)
		return (async function* (): AsyncGenerator<StreamEvent> {
			yield { type: 'text', text: 'ok' }
			yield { type: 'done', reason: 'end' }
		})()
	}
})

afterEach(() => {
	host.reset()
	sessions.closeAll()
	history.state.running.clear()
	turns.stream = origStream
	liveFiles.onError = origOnError
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

function start() {
	let events: Event[] = []
	let conn = host.connect((e) => events.push(e))
	conn.send({ type: 'create', cwd: work, model: 'anthropic/claude-test' })
	let id = (events.find((e) => e.type === 'snapshot') as any).sessionId as string
	let ended = () => events.filter((e) => e.type === 'turn-end').length
	let prompt = async (text: string) => {
		let n = ended()
		conn.send({ type: 'submit', sessionId: id, text })
		await until(() => ended() > n)
	}
	let command = async (text: string) => {
		let n = events.filter((e) => e.type === 'output').length
		conn.send({ type: 'submit', sessionId: id, text })
		await until(() => events.filter((e) => e.type === 'output').length > n)
	}
	return { id, prompt, command }
}

const lastPrompt = (messages: Message[]) => {
	let m = messages.findLast((m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text' && b.text.startsWith('[')))!
	return m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
}

test('every request carries the system prompt, unchanged between requests while its inputs are', async () => {
	let s = start()
	await s.prompt('one')
	await s.prompt('two')
	expect(requests).toHaveLength(2)
	let [a, b] = requests.map((r) => r.system!)
	expect(a).toContain(work)
	expect(a).toContain('anthropic/claude-test')
	expect(a).toContain('WORK RULE')
	expect(b).toBe(a)
})

test('/cd preserves the frozen system and delivers rendered sections on the next prompt', async () => {
	let s = start()
	await s.prompt('one')
	await s.command('/cd sub')
	await s.prompt('two')
	let system = requests[1]!.system!
	expect(system).toBe(requests[0]!.system!)
	let input = JSON.stringify(requests[1]!.messages)
	expect(input).toContain(`${work}/sub`)
	expect(input).toContain('SUB RULE')
	expect(lastPrompt(requests[1]!.messages)).toContain('two')
	expect(input).not.toContain('The working directory changed from')
	await s.prompt('three')
	expect(lastPrompt(requests[2]!.messages)).not.toContain('The working directory is now')
	expect(requests[2]!.system).toBe(system)
})

test('a provider-model switch rebuilds current system without a duplicate dedicated notice', async () => {
	let s = start()
	await s.prompt('one')
	slash.context(s.id).setModel('openai/gpt-test')
	await s.prompt('two')
	expect(requests[1]!.system).toContain('openai/gpt-test')
	expect(lastPrompt(requests[1]!.messages)).toContain('two')
	expect(JSON.stringify(requests[1]!.messages)).not.toContain('The model changed from')
	// Setting what it already is changes nothing.
	slash.context(s.id).setModel('openai/gpt-test')
	await s.prompt('three')
	expect(lastPrompt(requests[2]!.messages)).not.toContain('The model is now')
})
