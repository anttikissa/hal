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

test('run writes ui-only summary to target and fills empty target name', async () => {
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
	expect(sessions.loadHistory(requester).some((entry) => entry.type === 'assistant' && entry.syntheticKind === 'what-summary')).toBe(false)
	const targetHistory = sessions.loadHistory(target)
	expect(targetHistory).toContainEqual(expect.objectContaining({ type: 'assistant', synthetic: true, syntheticKind: 'what-summary', visibility: 'ui' }))
	const summary = targetHistory.find((entry) => entry.type === 'assistant' && entry.syntheticKind === 'what-summary')
	expect(summary?.type === 'assistant' ? summary.text : '').toContain('## Plan bug fix')
	expect(summary?.type === 'assistant' ? summary.text : '').not.toContain('session ')
	expect(summary?.type === 'assistant' ? summary.text : '').not.toContain('state idle/open')
	expect(targetHistory).toContainEqual(expect.objectContaining({ type: 'info', visibility: 'next-user', text: 'User ran /what for this session.' }))
	expect(events.some((event) => event.type === 'response' && event.sessionId === target && event.synthetic)).toBe(true)
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

	const targetHistory = sessions.loadHistory(target)
	const summary = targetHistory.find((entry) => entry.type === 'assistant' && entry.syntheticKind === 'what-summary')
	expect(summary?.type === 'assistant' ? summary.text : '').toContain('Summary failed: provider down')
})


test('summaries use isolated provider sessions', async () => {
	const requester = makeSession('requester', 'requester')
	const one = makeSession('one', 'one')
	const two = makeSession('two', 'two')
	const sessionIds: string[] = []
	const resetIds: string[] = []
	const origAppendEvent = ipc.appendEvent
	const origGetProvider = providerLoader.getProvider
	ipc.appendEvent = () => {}
	providerLoader.getProvider = async () => ({
		async *generate(req: any) {
			sessionIds.push(req.sessionId)
			yield { type: 'text' as const, text: "{ title: 'summary', summary: 'Summary.' }" }
		},
		resetSession(sessionId: string) {
			resetIds.push(sessionId)
		},
	})

	try {
		await whatSummary.run({ requesterSessionId: requester, target: '2-3', openSessionIds: [requester, one, two] })
	} finally {
		ipc.appendEvent = origAppendEvent
		providerLoader.getProvider = origGetProvider
	}

	expect(sessionIds).toHaveLength(2)
	expect(sessionIds[0]!.startsWith('what-')).toBe(true)
	expect(sessionIds[1]!.startsWith('what-')).toBe(true)
	expect(sessionIds[0]).not.toBe(sessionIds[1])
	expect(resetIds).toEqual(sessionIds)
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


test('summary prompt asks for compact grounded narrative style', () => {
	const prompt = whatSummary.systemPrompt()

	expect(prompt).toContain('initiating user problem')
	expect(prompt).toContain('capitalized')
	expect(prompt).toContain('short narrative')
	expect(prompt).toContain('Every sentence must help')
	expect(prompt).toContain('metadata inventories')
	expect(prompt).toContain('final relevant abbreviated commit hash')
	expect(prompt).toContain('grounded in the provided digest')
	expect(prompt).toContain('Strunk and White')
	expect(prompt).toContain('Do not write "the user"')
	expect(prompt).toContain('Tests passed.')
	expect(prompt).toContain('prompt came from another session')
	expect(prompt).toContain('Return only ASON with fields: title, summary')
	expect(prompt).not.toContain('fixed sections')
	expect(prompt).not.toContain('Desired style example')
	expect(prompt).not.toContain('active tab to rename itself left it paused')
})

test('digest includes deterministic attribution metadata', () => {
	const target = makeSession('attribution', 'summary work')
	sessions.updateMeta(target, {
		closedAt: '2026-06-10T13:00:00.000Z',
		spawnKind: 'subagent',
		parentSessionId: '34-parent',
		forkedFrom: '12-source',
	})

	const digest = whatSummary.buildDigest(target, [], {})

	expect(digest).toContain('Attribution:')
	expect(digest).toContain(`Session id: ${target}`)
	expect(digest).toContain('Tab: closed')
	expect(digest).toContain('Name: summary work')
	expect(digest).toContain('State: closed')
	expect(digest).toContain('Spawn kind: subagent')
	expect(digest).toContain('Agent role: subagent')
	expect(digest).toContain('Parent session id: 34-parent')
	expect(digest).toContain('Forked from: 12-source')
})


test('digest marks prompts sent from another session', () => {
	const target = makeSession('source', 'source')
	sessions.appendHistory(target, [
		{ type: 'user', source: '47-abc', parts: [{ type: 'text', text: 'Handoff from another tab.' }], ts: '2026-06-10T12:01:00.000Z' },
	])

	const digest = whatSummary.buildDigest(target, [target], {})

	expect(digest).toContain('prompt from session 47-abc')
	expect(digest).toContain('Handoff from another tab.')
})

test('digest puts conversation highlights before clipped tool details', () => {
	const target = makeSession('clipping', 'clipping')
	const origMaxDigestChars = whatSummary.config.maxDigestChars
	const origMaxFieldChars = whatSummary.config.maxFieldChars
	whatSummary.config.maxDigestChars = 1600
	whatSummary.config.maxFieldChars = 1000

	try {
		sessions.appendHistory(target, [
			{ type: 'user', parts: [{ type: 'text', text: 'Please design the migration; why is to avoid data loss.' }], ts: '2026-06-10T12:01:00.000Z' },
			{ type: 'assistant', text: 'Clarifying question: should we preserve legacy ids?', ts: '2026-06-10T12:02:00.000Z' },
			{ type: 'tool_result', toolId: 'read-1', output: 'implementation noise '.repeat(200), ts: '2026-06-10T12:03:00.000Z' },
			{ type: 'user', parts: [{ type: 'text', text: 'Yes, preserve ids. Plan approved.' }], ts: '2026-06-10T12:04:00.000Z' },
		])

		const digest = whatSummary.buildDigest(target, [target], {})

		expect(digest).toContain('Recent conversation and meta highlights:')
		expect(digest).toContain('Clarifying question: should we preserve legacy ids?')
		expect(digest).toContain('Yes, preserve ids. Plan approved.')
		expect(digest.indexOf('Recent conversation and meta highlights:')).toBeLessThan(digest.indexOf('Tool/action details:'))
	} finally {
		whatSummary.config.maxDigestChars = origMaxDigestChars
		whatSummary.config.maxFieldChars = origMaxFieldChars
	}
})


test('digest keeps initiating user request even after many later entries', () => {
	const target = makeSession('initial-request', 'later cleanup')
	const entries: any[] = [
		{ type: 'user', parts: [{ type: 'text', text: 'Initial request: make this URL clickable from the screenshot.' }], ts: '2026-06-10T12:01:00.000Z' },
	]
	for (let i = 0; i < 100; i++) {
		entries.push({ type: 'tool_result', toolId: `noise-${i}`, output: `routine implementation noise ${i}`, ts: '2026-06-10T12:02:00.000Z' })
	}
	entries.push({ type: 'user', parts: [{ type: 'text', text: 'Later follow-up: minor cleanup.' }], ts: '2026-06-10T12:03:00.000Z' })
	sessions.appendHistory(target, entries)

	const digest = whatSummary.buildDigest(target, [target], {})

	expect(digest).toContain('Opening conversation:')
	expect(digest).toContain('User request timeline:')
	expect(digest).toContain('Initial request: make this URL clickable from the screenshot.')
	expect(digest).toContain('Later follow-up: minor cleanup.')
})


test('digest highlights commit evidence before routine tool details', () => {
	const target = makeSession('commits', 'commits')
	sessions.appendHistory(target, [
		{ type: 'tool_call', toolId: 'commit-1', name: 'bash', input: { command: 'git commit -m "Add what command"' }, ts: '2026-06-10T12:01:00.000Z' },
		{ type: 'tool_result', toolId: 'commit-1', output: '[main abc1234] Add what command\n 2 files changed', ts: '2026-06-10T12:02:00.000Z' },
		{ type: 'tool_result', toolId: 'noise-1', output: 'routine output', ts: '2026-06-10T12:03:00.000Z' },
	])

	const digest = whatSummary.buildDigest(target, [target], {})

	expect(digest).toContain('Commit evidence:')
	expect(digest).toContain('git commit -m')
	expect(digest).toContain('[main abc1234] Add what command')
	expect(digest.indexOf('Commit evidence:')).toBeLessThan(digest.indexOf('Tool/action details:'))
})
