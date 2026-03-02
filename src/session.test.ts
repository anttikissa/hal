import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { stringify, parse, parseAll } from './utils/ason.ts'

// We can't change STATE_DIR after import, so instead we test the core logic
// directly by writing to a temp dir and using the public API with its configured state dir.
// For isolation, we use unique session IDs per test.

import {
	saveSession,
	loadSession,
	rotateSession,
	buildRotationContext,
	forkSession,
	replayConversationEvents,
	EMPTY_TOTALS,
	type ConversationEvent,
} from './session.ts'
import { sessionDir } from './state.ts'

function uniqueId(): string {
	return `t-${randomBytes(4).toString('hex')}`
}

afterEach(() => {
	// Clean up test sessions
})

describe('block storage', () => {
	test('saves and loads simple text messages', async () => {
		const id = uniqueId()
		const messages = [
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
		]

		await saveSession(id, messages, 0, { ...EMPTY_TOTALS })
		const result = await loadSession(id)

		expect(result).not.toBeNull()
		expect(result!.messages).toHaveLength(2)
		expect(result!.messages[0]).toEqual({ role: 'user', content: 'hello' })
		expect(result!.messages[1].role).toBe('assistant')
		expect(result!.messages[1].content[0].text).toBe('hi there')
	})

	test('saves thinking blocks to block files', async () => {
		const id = uniqueId()
		const messages = [
			{ role: 'user', content: 'think about this' },
			{
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'Let me think carefully...', signature: 'sig123' },
					{ type: 'text', text: 'Here is my answer' },
				],
			},
		]

		await saveSession(id, messages, 0, { ...EMPTY_TOTALS })

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
		const messages = [
			{ role: 'user', content: 'list files' },
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: 'Let me check.' },
					{ type: 'tool_use', id: 'toolu_01', name: 'bash', input: { command: 'ls' } },
				],
			},
			{
				role: 'user',
				content: [
					{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'file1.ts\nfile2.ts' },
				],
			},
		]

		await saveSession(id, messages, 0, { ...EMPTY_TOTALS })

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

	test('session.asonl contains refs not content', async () => {
		const id = uniqueId()
		const messages = [
			{
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'Deep thoughts here', signature: 'sig' },
					{ type: 'tool_use', id: 'toolu_01', name: 'read', input: { path: '/foo' } },
				],
			},
		]

		await saveSession(id, messages, 0, { ...EMPTY_TOTALS })

		const raw = readFileSync(join(sessionDir(id), 'session.asonl'), 'utf-8')
		// Should contain ref, not the actual thinking content
		expect(raw).toContain('ref')
		expect(raw).not.toContain('Deep thoughts here')
		expect(raw).not.toContain('/foo')
	})
})

describe('append-only save', () => {
	test('appends only new messages', async () => {
		const id = uniqueId()
		const messages: any[] = [{ role: 'user', content: 'first' }]

		const count1 = await saveSession(id, messages, 0, { ...EMPTY_TOTALS })
		expect(count1).toBe(1)

		messages.push({ role: 'assistant', content: [{ type: 'text', text: 'reply' }] })
		const count2 = await saveSession(id, messages, count1, { ...EMPTY_TOTALS })
		expect(count2).toBe(2)

		// Verify file has exactly 2 lines
		const raw = readFileSync(join(sessionDir(id), 'session.asonl'), 'utf-8')
		const lines = raw.trim().split('\n')
		expect(lines.length).toBe(2)

		// Verify round-trip
		const result = await loadSession(id)
		expect(result!.messages).toHaveLength(2)
		expect(result!.persistedCount).toBe(2)
	})

	test('does not write when nothing new', async () => {
		const id = uniqueId()
		const messages = [{ role: 'user', content: 'hello' }]

		await saveSession(id, messages, 0, { ...EMPTY_TOTALS })
		const stat1 = Bun.file(join(sessionDir(id), 'session.asonl')).size

		await saveSession(id, messages, 1, { ...EMPTY_TOTALS })
		const stat2 = Bun.file(join(sessionDir(id), 'session.asonl')).size

		expect(stat1).toBe(stat2)
	})
})

describe('rotation', () => {
	test('rotates session.asonl to session.1.asonl', async () => {
		const id = uniqueId()
		await saveSession(id, [{ role: 'user', content: 'hello' }], 0, { ...EMPTY_TOTALS })

		const rotN = await rotateSession(id)
		expect(rotN).toBe(1)

		expect(existsSync(join(sessionDir(id), 'session.asonl'))).toBe(false)
		expect(existsSync(join(sessionDir(id), 'session.1.asonl'))).toBe(true)
	})

	test('increments rotation number', async () => {
		const id = uniqueId()

		// First rotation
		await saveSession(id, [{ role: 'user', content: 'r1' }], 0, { ...EMPTY_TOTALS })
		expect(await rotateSession(id)).toBe(1)

		// Second rotation
		await saveSession(id, [{ role: 'user', content: 'r2' }], 0, { ...EMPTY_TOTALS })
		expect(await rotateSession(id)).toBe(2)

		// Third rotation
		await saveSession(id, [{ role: 'user', content: 'r3' }], 0, { ...EMPTY_TOTALS })
		expect(await rotateSession(id)).toBe(3)

		expect(existsSync(join(sessionDir(id), 'session.1.asonl'))).toBe(true)
		expect(existsSync(join(sessionDir(id), 'session.2.asonl'))).toBe(true)
		expect(existsSync(join(sessionDir(id), 'session.3.asonl'))).toBe(true)
	})

	test('returns 0 when no session file exists', async () => {
		expect(await rotateSession(uniqueId())).toBe(0)
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

describe('fork with blocks', () => {
	test('copies blocks directory', async () => {
		const srcId = uniqueId()
		const messages = [
			{ role: 'user', content: 'think' },
			{
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'Deep thoughts', signature: 'sig' },
					{ type: 'text', text: 'answer' },
				],
			},
		]

		await saveSession(srcId, messages, 0, { ...EMPTY_TOTALS })

		const newId = await forkSession(srcId)

		// Verify blocks were copied
		const srcBlocks = readdirSync(join(sessionDir(srcId), 'blocks'))
		const dstBlocks = readdirSync(join(sessionDir(newId), 'blocks'))
		expect(dstBlocks).toEqual(srcBlocks)

		// Verify forked session loads correctly
		const result = await loadSession(newId)
		expect(result!.messages[1].content[0].thinking).toBe('Deep thoughts')
	})
})

describe('replayConversationEvents', () => {
	test('start event is excluded from replay (not user/assistant)', () => {
		const events: ConversationEvent[] = [
			{ type: 'start', workingDir: '/tmp/project', ts: '2026-03-01T12:00:00.000Z' },
			{ type: 'user', text: 'hello', ts: '2026-03-01T12:01:00.000Z' },
			{ type: 'assistant', text: 'hi', ts: '2026-03-01T12:01:01.000Z' },
		]
		const replay = replayConversationEvents(events)
		expect(replay).toHaveLength(2)
		expect(replay[0].type).toBe('user')
		expect(replay[1].type).toBe('assistant')
	})

	test('start event after reset is not replayed', () => {
		const events: ConversationEvent[] = [
			{ type: 'start', workingDir: '/tmp', ts: '2026-03-01T12:00:00.000Z' },
			{ type: 'user', text: 'old', ts: '2026-03-01T12:01:00.000Z' },
			{ type: 'reset', ts: '2026-03-01T12:02:00.000Z' },
			{ type: 'user', text: 'new', ts: '2026-03-01T12:03:00.000Z' },
		]
		const replay = replayConversationEvents(events)
		expect(replay).toHaveLength(1)
		expect(replay[0].text).toBe('new')
	})

	test('thinking field is preserved in replay', () => {
		const events: ConversationEvent[] = [
			{ type: 'user', text: 'think hard', ts: '2026-03-01T12:01:00.000Z' },
			{ type: 'assistant', text: 'answer', thinking: 'deep thoughts', ts: '2026-03-01T12:01:01.000Z' },
		]
		const replay = replayConversationEvents(events)
		expect(replay).toHaveLength(2)
		expect(replay[1].type).toBe('assistant')
		expect((replay[1] as any).thinking).toBe('deep thoughts')
	})

	test('merged assistant events keep first thinking', () => {
		const events: ConversationEvent[] = [
			{ type: 'user', text: 'go', ts: '2026-03-01T12:01:00.000Z' },
			{ type: 'assistant', text: 'part1', thinking: 'initial thought', ts: '2026-03-01T12:01:01.000Z' },
			{ type: 'assistant', text: 'part2', ts: '2026-03-01T12:01:02.000Z' },
		]
		const replay = replayConversationEvents(events)
		expect(replay).toHaveLength(2)
		expect(replay[1].text).toBe('part1\n\npart2')
		expect((replay[1] as any).thinking).toBe('initial thought')
	})
})