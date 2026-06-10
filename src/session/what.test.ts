import { afterEach, expect, test } from 'bun:test'
import { sessions } from '../server/sessions.ts'
import { whatSummary } from './what.ts'
import { provider as providerLoader } from '../providers/provider.ts'
import { ipc } from '../ipc.ts'

const createdIds: string[] = []

function uniqueId(prefix: string): string {
	return `test-what-${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function makeSession(prefix: string, name?: string): string {
	const id = uniqueId(prefix)
	createdIds.push(id)
	sessions.createSession(id, {
		id,
		name,
		createdAt: '2026-06-10T12:00:00.000Z',
		workingDir: '/tmp/project',
		model: 'stub/test-model',
	})
	return id
}

afterEach(() => {
	for (const id of createdIds.splice(0)) sessions.deleteSession(id)
})

test('resolveTargets supports current, all, open ranges, and closed ids', () => {
	const requester = '04-requester'
	const openIds = ['04-one', '04-two', '04-three']
	const metas: any[] = [
		{ id: '04-one', name: 'main', createdAt: '2026-06-10T12:00:00.000Z' },
		{ id: '04-two', name: 'docs', createdAt: '2026-06-10T12:00:00.000Z' },
		{ id: '04-three', name: 'fix', createdAt: '2026-06-10T12:00:00.000Z' },
		{ id: '04-closed', name: 'old work', createdAt: '2026-06-09T12:00:00.000Z', closedAt: '2026-06-09T13:00:00.000Z' },
	]

	expect(whatSummary.resolveTargets('', requester, openIds, metas)).toEqual({ ok: true, ids: [requester] })
	expect(whatSummary.resolveTargets('--all', requester, openIds, metas)).toEqual({ ok: true, ids: openIds })
	expect(whatSummary.resolveTargets('2-3', requester, openIds, metas)).toEqual({ ok: true, ids: ['04-two', '04-three'] })
	expect(whatSummary.resolveTargets('04-closed', requester, openIds, metas)).toEqual({ ok: true, ids: ['04-closed'] })
})

test('run writes ui-only summary to requester and fills empty target name', async () => {
	const requester = makeSession('requester', 'requester')
	const target = makeSession('target')
	const events: any[] = []
	const origAppendEvent = ipc.appendEvent
	const origGetProvider = providerLoader.getProvider
	ipc.appendEvent = (event: any) => { events.push(event) }
	providerLoader.getProvider = async () => ({
		async *generate() {
			yield { type: 'text' as const, text: "{ title: 'plan bug fix', summary: 'User asked to plan and fix a bug. Hal inspected code and proposed changes.' }" }
			yield { type: 'done' as const, usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } }
		},
	})

	sessions.appendHistory(target, [
		{ type: 'user', parts: [{ type: 'text', text: 'please fix bug' }], ts: '2026-06-10T12:01:00.000Z' },
		{ type: 'assistant', text: 'I will inspect the code.', ts: '2026-06-10T12:02:00.000Z' },
	])

	try {
		await whatSummary.run({ requesterSessionId: requester, target: target, openSessionIds: [requester, target] })
	} finally {
		ipc.appendEvent = origAppendEvent
		providerLoader.getProvider = origGetProvider
	}

	expect(sessions.loadSessionMeta(target)?.name).toBe('plan bug fix')
	const requesterHistory = sessions.loadHistory(requester)
	expect(requesterHistory).toContainEqual(expect.objectContaining({ type: 'assistant', synthetic: true, syntheticKind: 'what-summary', visibility: 'ui' }))
	expect(requesterHistory).toContainEqual(expect.objectContaining({ type: 'info', visibility: 'next-user', text: `User ran /what for session ${target}.` }))
	expect(events.some((event) => event.type === 'response' && event.sessionId === requester && event.synthetic)).toBe(true)
})


test('run persists per-target summary errors', async () => {
	const requester = makeSession('requester', 'requester')
	const target = makeSession('target', 'target')
	const origAppendEvent = ipc.appendEvent
	const origGetProvider = providerLoader.getProvider
	ipc.appendEvent = () => {}
	providerLoader.getProvider = async () => ({
		async *generate() {
			yield { type: 'error' as const, message: 'provider down' }
		},
	})

	try {
		await whatSummary.run({ requesterSessionId: requester, target, openSessionIds: [requester, target] })
	} finally {
		ipc.appendEvent = origAppendEvent
		providerLoader.getProvider = origGetProvider
	}

	const requesterHistory = sessions.loadHistory(requester)
	const summary = requesterHistory.find((entry) => entry.type === 'assistant' && entry.syntheticKind === 'what-summary')
	expect(summary?.type === 'assistant' ? summary.text : '').toContain('Summary failed: provider down')
})

test('run does not overwrite existing target name', async () => {
	const requester = makeSession('requester', 'requester')
	const target = makeSession('target', 'manual name')
	const origAppendEvent = ipc.appendEvent
	const origGetProvider = providerLoader.getProvider
	ipc.appendEvent = () => {}
	providerLoader.getProvider = async () => ({
		async *generate() {
			yield { type: 'text' as const, text: "{ title: 'new title', summary: 'Summary.' }" }
			yield { type: 'done' as const, usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } }
		},
	})

	try {
		await whatSummary.run({ requesterSessionId: requester, target: target, openSessionIds: [requester, target] })
	} finally {
		ipc.appendEvent = origAppendEvent
		providerLoader.getProvider = origGetProvider
	}

	expect(sessions.loadSessionMeta(target)?.name).toBe('manual name')
})
