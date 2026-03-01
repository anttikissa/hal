import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { parseAll, parse } from '../utils/ason.ts'
import { startHal, type TestHal } from './helpers/harness.ts'

let hal: TestHal | null = null

beforeEach(() => {
	Bun.env.HAL_TEST_NO_UI = '1'
})

afterEach(async () => {
	if (hal) {
		await hal.stop()
		hal = null
	}
})

function parseForkIds(text: string): { parent: string; child: string } {
	const match = text.match(/\[fork\] forked (s-[a-zA-Z0-9_-]+) -> (s-[a-zA-Z0-9_-]+)/)
	if (!match) throw new Error(`could not parse fork ids from line: ${text}`)
	return { parent: match[1], child: match[2] }
}
async function readConversationLog(hal: TestHal, sessionId: string): Promise<any[]> {
	const path = `${hal.halDir}/state/sessions/${sessionId}/conversation.asonl`
	for (let i = 0; i < 40; i++) {
		try {
			const raw = await readFile(path, 'utf-8')
			return parseAll(raw) as any[]
		} catch {}
		await Bun.sleep(25)
	}
	throw new Error(`conversation log not found: ${path}`)
}

/** Read session messages and resolve block refs back to full content. */
async function readSessionMessages(hal: TestHal, sessionId: string): Promise<any[]> {
	const sessDir = `${hal.halDir}/state/sessions/${sessionId}`
	const path = `${sessDir}/session.asonl`
	for (let i = 0; i < 60; i++) {
		try {
			const raw = await readFile(path, 'utf-8')
			const leanMessages = parseAll(raw) as any[]
			if (leanMessages.length === 0) { await Bun.sleep(50); continue }

			// Resolve refs
			const messages: any[] = []
			for (const lean of leanMessages) {
				if (lean.role === 'assistant') {
					const content: any[] = []
					if (lean.thinking?.ref) {
						const blockPath = `${sessDir}/blocks/${lean.thinking.ref}.ason`
						if (existsSync(blockPath)) {
							const block = parse(await readFile(blockPath, 'utf-8')) as any
							content.push({ type: 'thinking', thinking: block.thinking, signature: block.signature })
						}
					}
					if (typeof lean.content === 'string') {
						if (lean.content) content.push({ type: 'text', text: lean.content })
					} else if (Array.isArray(lean.content)) {
						for (const b of lean.content) {
							if (b.type === 'tool_use' && b.ref) {
								const blockPath = `${sessDir}/blocks/${b.ref}.ason`
								if (existsSync(blockPath)) {
									const block = parse(await readFile(blockPath, 'utf-8')) as any
									content.push({ type: 'tool_use', id: b.id, name: b.name, input: block?.call?.input ?? {} })
								}
							} else {
								content.push(b)
							}
						}
					}
					messages.push({ role: 'assistant', content })
				} else if (lean.role === 'user' && Array.isArray(lean.content)) {
					const content: any[] = []
					for (const b of lean.content) {
						if (b.type === 'tool_result' && b.ref) {
							const blockPath = `${sessDir}/blocks/${b.ref}.ason`
							if (existsSync(blockPath)) {
								const block = parse(await readFile(blockPath, 'utf-8')) as any
								content.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: block?.result?.content ?? '' })
							}
						} else {
							content.push(b)
						}
					}
					messages.push({ role: 'user', content })
				} else {
					const { ts, ...rest } = lean
					messages.push(rest)
				}
			}
			return messages
		} catch {}
		await Bun.sleep(50)
	}
	throw new Error(`session file not found: ${path}`)
}

describe('fork', () => {
	test('/fork creates new session', async () => {
		hal = await startHal()
		await hal.waitForReady()

		// Wait for initial session to be established
		const initial = await hal.waitFor(
			(r) => r.type === 'sessions' && r.sessions?.length >= 1,
		)
		const originalId = initial.sessions[0].id

		hal.sendLine('/fork')

		// Should see fork status line
		await hal.waitForLine(/\[fork\] forked/)

		// Sessions event should now have more than 1 session
		const sessions = await hal.waitFor(
			(r) => r.type === 'sessions' && r.sessions?.length >= 2,
		)
		expect(sessions.sessions.length).toBeGreaterThanOrEqual(2)

		// Original session should still exist
		expect(sessions.sessions.some((s: any) => s.id === originalId)).toBe(true)
	})

	test('/fork while generating does not interrupt original session', async () => {
		hal = await startHal()
		await hal.waitForReady()

		// Switch to mock provider (streams song slowly at 120ms/syllable)
		hal.sendLine('/model mock')
		await hal.waitForLine(/\[model\] .*->.*mock/)

		// Start generating a song (long stream so we can fork mid-generation)
		hal.sendLine('song')

		// Wait for a few chunks to confirm generation started
		await hal.waitFor(
			(r) => r.type === 'chunk' && r.channel === 'assistant' && /Dai/.test(r.text ?? ''),
		)

		// Fork while generating
		hal.sendLine('/fork')
		await hal.waitForLine(/\[fork\] forked/)

		// Record how many chunks we had at fork time
		const chunksAtFork = hal.records.filter(
			(r) => r.type === 'chunk' && r.channel === 'assistant',
		).length

		// Parent must keep streaming after fork (without waiting for full song)
		await hal.waitFor(
			() =>
				hal!.records.filter((r) => r.type === 'chunk' && r.channel === 'assistant')
					.length >= chunksAtFork + 2,
			3000,
		)

		// Should have received more chunks after the fork
		const chunksAtEnd = hal.records.filter(
			(r) => r.type === 'chunk' && r.channel === 'assistant',
		).length
		expect(chunksAtEnd).toBeGreaterThan(chunksAtFork)

		// Should have 2 sessions now
		const sessions = await hal.waitFor(
			(r) => r.type === 'sessions' && r.sessions?.length >= 2,
		)
		expect(sessions.sessions.length).toBeGreaterThanOrEqual(2)

		// Stop the long stream so test teardown is fast
		hal.sendLine('/pause')
		await hal.waitForLine(/\[pause\]/, 3000)
	}, 15000)

	test('/fork while generating marks child paused and emits paused fork line', async () => {
		hal = await startHal()
		await hal.waitForReady()

		hal.sendLine('/model mock')
		await hal.waitForLine(/\[model\] .*->.*mock/)

		hal.sendLine('song')
		await hal.waitFor(
			(r) => r.type === 'chunk' && r.channel === 'assistant' && /Dai/.test(r.text ?? ''),
		)

		hal.sendLine('/fork')

		const childLine = await hal.waitFor(
			(r) =>
				r.type === 'line' &&
				r.level === 'fork' &&
				/\[fork\] forked from s-[a-zA-Z0-9_-]+ \(paused\)/.test(r.text ?? ''),
			10000,
		)
		expect(childLine.level).toBe('fork')
		expect(childLine.session).toBeTruthy()

		const childId = childLine.session as string
		const status = await hal.waitFor(
			(r) =>
				r.type === 'status' &&
				Array.isArray(r.pausedSessions) &&
				r.pausedSessions.includes(childId),
			10000,
		)
		expect(status.pausedSessions).toContain(childId)
	}, 15000)

	test('/fork inserts session next to parent', async () => {
		hal = await startHal()
		await hal.waitForReady()

		await hal.waitFor((r) => r.type === 'sessions' && r.sessions?.length >= 1)
		hal.sendLine('/fork')
		const afterFirstFork = await hal.waitFor(
			(r) => r.type === 'sessions' && r.sessions?.length >= 2,
		)

		const parentId = afterFirstFork.active as string
		const beforeIds = new Set(afterFirstFork.sessions.map((s: any) => s.id))

		hal.sendLine('/fork')
		const afterSecondFork = await hal.waitFor(
			(r) =>
				r.type === 'sessions' &&
				r.sessions?.length >= 3 &&
				r.active &&
				!beforeIds.has(r.active),
		)

		const childId = afterSecondFork.active as string
		const parentIndex = afterSecondFork.sessions.findIndex((s: any) => s.id === parentId)
		const childIndex = afterSecondFork.sessions.findIndex((s: any) => s.id === childId)
		expect(parentIndex).toBeGreaterThanOrEqual(0)
		expect(parentIndex).toBeLessThan(afterSecondFork.sessions.length - 1)
		expect(childIndex).toBe(parentIndex + 1)
	})

	test('/fork writes lineage events to conversation logs', async () => {
		hal = await startHal()
		await hal.waitForReady()

		const sessions = await hal.waitFor(
			(r) => r.type === 'sessions' && r.sessions?.length >= 1,
		)
		const sourceId = sessions.sessions[0].id

		hal.sendLine('/fork')
		const line = await hal.waitForLine(/\[fork\] forked s-[a-zA-Z0-9_-]+ -> s-[a-zA-Z0-9_-]+/)
		const { parent, child } = parseForkIds(line.text)
		expect(parent).toBe(sourceId)

		const parentLog = await readConversationLog(hal, parent)
		const childLog = await readConversationLog(hal, child)

		const parentForkEvent = parentLog.find(
			(evt) => evt.type === 'fork' && evt.parent === parent && evt.child === child,
		)
		const childForkEvent = childLog.find(
			(evt) => evt.type === 'fork' && evt.parent === parent && evt.child === child,
		)

		expect(parentForkEvent).toBeTruthy()
		expect(childForkEvent).toBeTruthy()
		expect(childForkEvent.ts).toBe(parentForkEvent.ts)
	})

	test('/fork while busy snapshots partial assistant blocks into child session', async () => {
		hal = await startHal()
		await hal.waitForReady()

		hal.sendLine('/model mock')
		await hal.waitForLine(/\[model\] .*->.*mock/)

		hal.sendLine('song')
		await hal.waitFor(
			(r) => r.type === 'chunk' && r.channel === 'assistant' && /Dai/.test(r.text ?? ''),
			10000,
		)

		hal.sendLine('/fork')
		const childLine = await hal.waitFor(
			(r) => r.type === 'line' && r.level === 'fork' && /\(paused\)/.test(r.text ?? ''),
			10000,
		)
		const childId = childLine.session as string

		hal.sendLine('hello from child')
		const queued = await hal.waitFor(
			(r) => r.type === 'command' && r.session === childId && r.phase === 'queued',
		)
		await hal.waitFor(
			(r) => r.type === 'command' && r.commandId === queued.commandId && r.phase === 'done',
			10000,
		)

		const messages = await readSessionMessages(hal, childId)
		const hasPartialDaisySnapshot = messages.some(
			(msg: any) =>
				msg?.role === 'assistant' &&
				Array.isArray(msg.content) &&
				msg.content.some((b: any) => b?.type === 'text' && /Dai/.test(String(b.text ?? ''))),
		)
		expect(hasPartialDaisySnapshot).toBe(true)
	}, 20000)
})
