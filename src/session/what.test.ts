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
	const summary = requesterHistory.find((entry) => entry.type === 'assistant' && entry.syntheticKind === 'what-summary')
	expect(summary?.type === 'assistant' ? summary.text : '').toContain('## plan bug fix')
	expect(summary?.type === 'assistant' ? summary.text : '').not.toContain('session ')
	expect(summary?.type === 'assistant' ? summary.text : '').not.toContain('state idle/open')
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


test('summary prompt asks for compact narrative style with concrete example', () => {
	const prompt = whatSummary.systemPrompt()

	expect(prompt).toContain('initiating user problem')
	expect(prompt).toContain('short narrative')
	expect(prompt).toContain('Every sentence must help')
	expect(prompt).toContain('metadata inventories')
	expect(prompt).toContain('final relevant abbreviated commit hash')
	expect(prompt).toContain('Desired style example')
	expect(prompt).toContain('active tab to rename itself left it paused')
	expect(prompt).toContain('Commit 9b71e64 — Remove dead client command branches')
	expect(prompt).toContain('Return only ASON with fields: title, summary')
	expect(prompt).not.toContain('fixed sections')
	expect(prompt).not.toContain('Commits made; Files, actions, and evidence')
})


test('golden tab4-style summary favors initiating bug over later cleanup', async () => {
	const requester = makeSession('requester', 'requester')
	const target = makeSession('tab4', 'minor client command cleanup')
	const origAppendEvent = ipc.appendEvent
	const origGetProvider = providerLoader.getProvider
	let captured: any
	const golden = [
		'You showed a case where asking an active tab to rename itself left it paused. Hal diagnosed this as a bug in safe/local-ish command handling and fixed the agreed command paths so those commands do not unnecessarily pause or abort active work.',
		'',
		'Follow-up: after the main bug fix, you approved minor cleanup and said not to worry about tests in that old session.',
		'',
		'- Touched commands.ts, client.ts, local-commands.ts, plus a small runtime.ts cleanup.',
		'- Removed dead client command branches / about 9 LOC.',
		'- Commit 9b71e64 — Remove dead client command branches.',
	].join('\n')
	ipc.appendEvent = () => {}
	providerLoader.getProvider = async () => ({
		async *generate(req: any) {
			captured = req
			yield { type: 'text' as const, text: `{ title: ${JSON.stringify('active session rename pause bug')}, summary: ${JSON.stringify(golden)} }` }
		},
	})

	sessions.appendHistory(target, [
		{ type: 'user', parts: [{ type: 'text', text: 'Screenshot: asking active tab 40 to rename itself left it paused. Is this a bug?' }], ts: '2026-06-10T12:01:00.000Z' },
		{ type: 'assistant', text: 'Yes, this looks like active-session safe command handling is wrong. Plan: keep local-ish commands from pausing active work.', ts: '2026-06-10T12:02:00.000Z' },
		{ type: 'user', parts: [{ type: 'text', text: 'Plan approved. Fix it.' }], ts: '2026-06-10T12:03:00.000Z' },
		{ type: 'user', parts: [{ type: 'text', text: 'There is a minor cleanup too, go ahead; do not worry about tests.' }], ts: '2026-06-10T12:04:00.000Z' },
		{ type: 'tool_result', toolId: 'commit-1', output: '[main 9b71e64] Remove dead client command branches\n 4 files changed', ts: '2026-06-10T12:05:00.000Z' },
	])

	try {
		await whatSummary.run({ requesterSessionId: requester, target, openSessionIds: [requester, target] })
	} finally {
		ipc.appendEvent = origAppendEvent
		providerLoader.getProvider = origGetProvider
	}

	const digest = captured.messages[0].content as string
	expect(captured.systemPrompt).toContain('Desired style example')
	expect(digest).toContain('active tab 40 to rename itself left it paused')
	expect(digest).toContain('minor cleanup')
	expect(digest).toContain('[main 9b71e64] Remove dead client command branches')

	const summary = sessions.loadHistory(requester).find((entry) => entry.type === 'assistant' && entry.syntheticKind === 'what-summary')
	const text = summary?.type === 'assistant' ? summary.text : ''
	expect(text).toContain('## active session rename pause bug')
	expect(text).toContain(golden)
	expect(text).not.toContain('session id')
	expect(text).not.toContain('history.asonl')
	expect(text).not.toContain('No next steps')
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

		expect(digest).toContain('Conversation and meta highlights:')
		expect(digest).toContain('Clarifying question: should we preserve legacy ids?')
		expect(digest).toContain('Yes, preserve ids. Plan approved.')
		expect(digest.indexOf('Conversation and meta highlights:')).toBeLessThan(digest.indexOf('Tool/action details:'))
	} finally {
		whatSummary.config.maxDigestChars = origMaxDigestChars
		whatSummary.config.maxFieldChars = origMaxFieldChars
	}
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
