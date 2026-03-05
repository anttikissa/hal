import { describe, test, expect, afterEach } from 'bun:test'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { stringify, parseAll } from './utils/ason.ts'

import {
	appendToLog,
	writeAssistantEntry,
	writeToolResultEntry,
	loadSession,
	readBlock,
	rotateSession,
	buildRotationContext,
	forkSession,
	loadReplayEntries,
	loadSessionRegistry,
	saveSessionInfo,
	saveSessionRegistry,
	sessionInfoMap,
	EMPTY_TOTALS,
} from './session.ts'
import { sessionDir } from './state.ts'

function uniqueId(): string {
	const id = `t-${randomBytes(4).toString('hex')}`
	sessionInfoMap.set(id, {
		id, workingDir: '/tmp', currentLog: 'messages.asonl', busy: false, messageCount: 0,
		createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
	})
	return id
}

afterEach(() => {
	// Clean up test sessions
})

describe('unified log — block storage', () => {
	test('saves and loads simple text messages', async () => {
		const id = uniqueId()
		await appendToLog(id, [
			{ role: 'user', content: 'hello', ts: new Date().toISOString() },
		])
		const { entry } = await writeAssistantEntry(id, [{ type: 'text', text: 'hi there' }])
		await appendToLog(id, [entry])

		const result = await loadSession(id)
		expect(result).not.toBeNull()
		expect(result!.messages).toHaveLength(2)
		expect(result!.messages[0]).toEqual({ role: 'user', content: 'hello' })
		expect(result!.messages[1].role).toBe('assistant')
		expect(result!.messages[1].content[0].text).toBe('hi there')
	})

	test('saves thinking blocks to block files', async () => {
		const id = uniqueId()
		await appendToLog(id, [
			{ role: 'user', content: 'think about this', ts: new Date().toISOString() },
		])
		const { entry } = await writeAssistantEntry(id, [
			{ type: 'thinking', thinking: 'Let me think carefully...', signature: 'sig123' },
			{ type: 'text', text: 'Here is my answer' },
		])
		await appendToLog(id, [entry])

		// Verify block file was created
		const blocks = readdirSync(join(sessionDir(id), 'blocks'))
		expect(blocks.length).toBe(1)
		expect(blocks[0]).toEndWith('.ason')

		// Verify round-trip
		const result = await loadSession(id)
		expect(result!.messages[1].content[0].type).toBe('thinking')
		expect(result!.messages[1].content[0].thinking).toBe('Let me think carefully...')
		expect(result!.messages[1].content[0].signature).toBe('sig123')
		expect(result!.messages[1].content[1].text).toBe('Here is my answer')
	})

	test('saves tool calls to block files', async () => {
		const id = uniqueId()
		await appendToLog(id, [
			{ role: 'user', content: 'list files', ts: new Date().toISOString() },
		])
		const { entry, toolRefMap } = await writeAssistantEntry(id, [
			{ type: 'text', text: 'Let me check.' },
			{ type: 'tool_use', id: 'toolu_01', name: 'bash', input: { command: 'ls' } },
		])
		await appendToLog(id, [entry])

		// Write tool result
		const trEntry = await writeToolResultEntry(id, 'toolu_01', 'file1.ts\nfile2.ts', toolRefMap)
		await appendToLog(id, [trEntry])

		// Verify block files were created (1 for tool call+result)
		const blocks = readdirSync(join(sessionDir(id), 'blocks'))
		expect(blocks.length).toBe(1)

		// Verify round-trip
		const result = await loadSession(id)
		expect(result!.messages).toHaveLength(3)
		expect(result!.messages[1].content[1].name).toBe('bash')
		expect(result!.messages[1].content[1].input).toEqual({ command: 'ls' })
		expect(result!.messages[2].content[0].content).toBe('file1.ts\nfile2.ts')
	})

	test('messages.asonl contains refs not content', async () => {
		const id = uniqueId()
		const { entry } = await writeAssistantEntry(id, [
			{ type: 'thinking', thinking: 'Deep thoughts here', signature: 'sig' },
			{ type: 'tool_use', id: 'toolu_01', name: 'read', input: { path: '/foo' } },
		])
		await appendToLog(id, [entry])

		const raw = readFileSync(join(sessionDir(id), 'messages.asonl'), 'utf-8')
		// Should contain ref, not the actual thinking content
		expect(raw).toContain('ref')
		expect(raw).not.toContain('Deep thoughts here')
		expect(raw).not.toContain('/foo')
	})
})

describe('unified log — append-only', () => {
	test('appends only new entries', async () => {
		const id = uniqueId()
		await appendToLog(id, [{ role: 'user', content: 'first', ts: new Date().toISOString() }])

		const raw1 = readFileSync(join(sessionDir(id), 'messages.asonl'), 'utf-8')
		expect(raw1.trim().split('\n').length).toBe(1)

		const { entry } = await writeAssistantEntry(id, [{ type: 'text', text: 'reply' }])
		await appendToLog(id, [entry])

		const raw2 = readFileSync(join(sessionDir(id), 'messages.asonl'), 'utf-8')
		expect(raw2.trim().split('\n').length).toBe(2)

		// Verify round-trip
		const result = await loadSession(id)
		expect(result!.messages).toHaveLength(2)
	})
})

describe('rotation', () => {
	test('rotates to messages2.asonl', async () => {
		const id = uniqueId()
		await appendToLog(id, [{ role: 'user', content: 'hello', ts: new Date().toISOString() }])

		const rotN = await rotateSession(id)
		expect(rotN).toBe(2)

		// Old file stays, new file doesn't exist yet (until something writes to it)
		expect(existsSync(join(sessionDir(id), 'messages.asonl'))).toBe(true)
	})

	test('increments rotation number', async () => {
		const id = uniqueId()
		await appendToLog(id, [{ role: 'user', content: 'r1', ts: new Date().toISOString() }])
		expect(await rotateSession(id)).toBe(2)

		// Write to new log file
		await appendToLog(id, [{ role: 'user', content: 'r2', ts: new Date().toISOString() }])
		expect(await rotateSession(id)).toBe(3)

		await appendToLog(id, [{ role: 'user', content: 'r3', ts: new Date().toISOString() }])
		expect(await rotateSession(id)).toBe(4)
	})

	test('returns 0 when no messages file exists', async () => {
		expect(await rotateSession(uniqueId())).toBe(0)
	})

	test('loadSession reads from current log after rotation', async () => {
		const id = uniqueId()
		await appendToLog(id, [{ role: 'user', content: 'old', ts: new Date().toISOString() }])
		await appendToLog(id, [{ type: 'handoff', ts: new Date().toISOString() }])
		await rotateSession(id)
		await appendToLog(id, [{ role: 'user', content: 'new context', ts: new Date().toISOString() }])

		const result = await loadSession(id)
		expect(result).not.toBeNull()
		expect(result!.messages).toHaveLength(1)
		expect(result!.messages[0].content).toBe('new context')
	})
})

describe('buildRotationContext', () => {
	test('includes user prompts', () => {
		const messages = [
			{ role: 'user', content: 'implement feature X' },
			{ role: 'assistant', content: [{ type: 'text', text: 'done' }] },
			{ role: 'user', content: 'now test it' },
		]

		const context = buildRotationContext('test-ctx', messages)
		expect(context).toContain('implement feature X')
		expect(context).toContain('now test it')
		expect(context).toContain('Session context was purged')
	})

	test('skips internal markers', () => {
		const messages = [
			{ role: 'user', content: '[forked to s-123]' },
			{ role: 'user', content: 'real prompt' },
			{ role: 'user', content: '[model changed from a to b]' },
		]

		const context = buildRotationContext('test-skip', messages)
		expect(context).toContain('real prompt')
		expect(context).not.toContain('forked')
		expect(context).not.toContain('model changed')
	})

	test('windows to first 10 + last 10 for large sessions', () => {
		const messages: any[] = []
		for (let i = 0; i < 30; i++) {
			messages.push({ role: 'user', content: `prompt ${i}` })
			messages.push({ role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }] })
		}

		const context = buildRotationContext('test-window', messages)
		expect(context).toContain('prompt 0')
		expect(context).toContain('prompt 9')
		expect(context).toContain('prompt 20')
		expect(context).toContain('prompt 29')
		expect(context).toContain('First 10')
		expect(context).toContain('Last 10')
	})
})

describe('fork by reference', () => {
	test('does not copy files, resolves blocks via parent', async () => {
		const srcId = uniqueId()
		await appendToLog(srcId, [
			{ role: 'user', content: 'think', ts: new Date().toISOString() },
		])
		const { entry } = await writeAssistantEntry(srcId, [
			{ type: 'thinking', thinking: 'Deep thoughts', signature: 'sig' },
			{ type: 'text', text: 'answer' },
		])
		await appendToLog(srcId, [entry])

		const newId = await forkSession(srcId)

		// No blocks copied — child has no blocks dir
		expect(existsSync(join(sessionDir(newId), 'blocks'))).toBe(false)

		// But readBlock resolves via parent chain
		const block = await readBlock(newId, entry.thinking.ref)
		expect(block).not.toBeNull()
		expect(block.thinking).toBe('Deep thoughts')
	})

	test('loads parent messages via fork reference', async () => {
		const srcId = uniqueId()
		const ts = new Date().toISOString()
		await appendToLog(srcId, [{ role: 'user', content: 'hello', ts }])
		const { entry } = await writeAssistantEntry(srcId, [
			{ type: 'text', text: 'hi there' },
		])
		await appendToLog(srcId, [entry])

		const newId = await forkSession(srcId)
		await appendToLog(newId, [{ role: 'user', content: 'follow-up', ts: new Date().toISOString() }])

		const result = await loadSession(newId)
		expect(result).not.toBeNull()
		expect(result!.messages).toHaveLength(3)
		expect(result!.messages[0].content).toBe('hello')
		expect(result!.messages[2].content).toBe('follow-up')
	})

	test('excludes parent entries written after fork', async () => {
		const srcId = uniqueId()
		const ts = new Date().toISOString()
		await appendToLog(srcId, [{ role: 'user', content: 'before fork', ts }])

		const newId = await forkSession(srcId)

		// Parent gets new messages after the fork
		await Bun.sleep(2)
		await appendToLog(srcId, [{ role: 'user', content: 'after fork', ts: new Date().toISOString() }])

		const result = await loadSession(newId)
		expect(result).not.toBeNull()
		const texts = result!.messages.map((m: any) => m.content)
		expect(texts).toContain('before fork')
		expect(texts).not.toContain('after fork')
	})

	test('chained forks resolve recursively', async () => {
		const ts = new Date().toISOString()
		const grandparent = uniqueId()
		await appendToLog(grandparent, [{ role: 'user', content: 'gen1', ts }])

		const parent = await forkSession(grandparent)
		await appendToLog(parent, [{ role: 'user', content: 'gen2', ts: new Date().toISOString() }])

		const child = await forkSession(parent)
		await appendToLog(child, [{ role: 'user', content: 'gen3', ts: new Date().toISOString() }])

		const result = await loadSession(child)
		expect(result).not.toBeNull()
		const texts = result!.messages.map((m: any) => m.content)
		expect(texts).toContain('gen1')
		expect(texts).toContain('gen2')
		expect(texts).toContain('gen3')
	})
})

describe('replay entries', () => {
	test('start event is included, tool_result is skipped', async () => {
		const id = uniqueId()
		const ts = new Date().toISOString()
		await appendToLog(id, [
			{ type: 'start', workingDir: '/tmp/project', ts },
			{ role: 'user', content: 'hello', ts },
			{ role: 'assistant', text: 'hi', ts },
		])

		const entries = await loadReplayEntries(id)
		expect(entries).toHaveLength(3)
		expect(entries[0].type).toBe('start')
		expect(entries[1].role).toBe('user')
		expect(entries[2].role).toBe('assistant')
	})

	test('truncates at reset', async () => {
		const id = uniqueId()
		const ts = new Date().toISOString()
		await appendToLog(id, [
			{ type: 'start', workingDir: '/tmp', ts },
			{ role: 'user', content: 'old', ts },
			{ type: 'reset', ts },
			{ role: 'user', content: 'new', ts },
		])

		const entries = await loadReplayEntries(id)
		expect(entries).toHaveLength(1)
		expect(entries[0].content).toBe('new')
	})

	test('tool_log entries are included', async () => {
		const id = uniqueId()
		const ts = new Date().toISOString()
		await appendToLog(id, [
			{ role: 'user', content: 'do it', ts },
			{ role: 'assistant', text: 'calling tool', ts },
			{ type: 'tool_log', text: '[bash] ls\nfile.ts', ts },
			{ role: 'assistant', text: 'done', ts },
		])

		const entries = await loadReplayEntries(id)
		expect(entries).toHaveLength(4)
		expect(entries[0].role).toBe('user')
		expect(entries[1].role).toBe('assistant')
		expect(entries[2].type).toBe('tool_log')
		expect(entries[3].role).toBe('assistant')
	})

	test('thinking text is resolved from blocks', async () => {
		const id = uniqueId()
		const { entry } = await writeAssistantEntry(id, [
			{ type: 'thinking', thinking: 'deep thoughts', signature: 'sig' },
			{ type: 'text', text: 'answer' },
		])
		await appendToLog(id, [
			{ role: 'user', content: 'think hard', ts: new Date().toISOString() },
			entry,
		])

		const entries = await loadReplayEntries(id)
		const assistant = entries.find((e: any) => e.role === 'assistant')
		expect(assistant._thinkingText).toBe('deep thoughts')
	})

	test('assistant tool calls are resolved with input and result for replay', async () => {
		const id = uniqueId()
		const ts = new Date().toISOString()
		await appendToLog(id, [{ role: 'user', content: 'run a command', ts }])
		const { entry, toolRefMap } = await writeAssistantEntry(id, [
			{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'echo hi' } },
		])
		await appendToLog(id, [entry])
		const resultEntry = await writeToolResultEntry(id, 'toolu_1', 'hi', toolRefMap)
		await appendToLog(id, [resultEntry])

		const entries = await loadReplayEntries(id)
		const assistant = entries.find((e: any) => e.role === 'assistant')
		expect(assistant).toBeTruthy()
		expect(assistant._toolCalls).toEqual([
			{ id: 'toolu_1', name: 'bash', input: { command: 'echo hi' }, result: 'hi' },
		])
	})
})

describe('context trimming', () => {
	test('old tool results are replaced with placeholder', async () => {
		const id = uniqueId()
		const ts = new Date().toISOString()

		// Write 5 tool call cycles
		for (let i = 0; i < 5; i++) {
			await appendToLog(id, [{ role: 'user', content: `query ${i}`, ts }])
			const { entry, toolRefMap } = await writeAssistantEntry(id, [
				{ type: 'text', text: `checking ${i}` },
				{ type: 'tool_use', id: `toolu_${i}`, name: 'bash', input: { command: `cmd${i}` } },
			])
			await appendToLog(id, [entry])
			const trEntry = await writeToolResultEntry(id, `toolu_${i}`, `result ${i}`, toolRefMap)
			await appendToLog(id, [trEntry])
		}

		const result = await loadSession(id)
		expect(result).not.toBeNull()

		// Find tool results — first 2 should be trimmed, last 3 should be full
		const toolResults: string[] = []
		for (const msg of result!.messages) {
			if (Array.isArray(msg.content)) {
				for (const b of msg.content) {
					if (b.type === 'tool_result') toolResults.push(b.content)
				}
			}
		}

		expect(toolResults).toHaveLength(5)
		expect(toolResults[0]).toBe('[tool result omitted — run the tool again if needed]')
		expect(toolResults[1]).toBe('[tool result omitted — run the tool again if needed]')
		expect(toolResults[2]).toBe('result 2')
		expect(toolResults[3]).toBe('result 3')
		expect(toolResults[4]).toBe('result 4')
	})
})

describe('loadSessionRegistry merges info.ason', () => {
	test('preserves currentLog and lastPrompt after restart', async () => {
		const id = uniqueId()
		await appendToLog(id, [{ role: 'user', content: 'hello', ts: new Date().toISOString() }])

		// Simulate rotation: sets currentLog in info.ason
		await rotateSession(id)
		const session = sessionInfoMap.get(id)!
		session.lastPrompt = 'hello'
		await saveSessionInfo(id)

		// Verify info.ason has both fields
		const infoRaw = readFileSync(join(sessionDir(id), 'info.ason'), 'utf-8')
		expect(infoRaw).toContain('messages2.asonl')
		expect(infoRaw).toContain('hello')

		// Save a slim registry (like shutdown does — no currentLog/lastPrompt)
		const registry = { activeSessionId: id, sessions: [session] }
		await saveSessionRegistry(registry)

		// Clear in-memory state
		sessionInfoMap.delete(id)

		// Reload — should merge info.ason fields back
		const loaded = await loadSessionRegistry()
		const restored = sessionInfoMap.get(id)
		expect(restored).toBeDefined()
		expect(restored!.currentLog).toBe('messages2.asonl')
		expect(restored!.lastPrompt).toBe('hello')
	})
})
