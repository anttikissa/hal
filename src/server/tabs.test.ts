import { expect, test } from 'bun:test'
import { tabs } from './tabs.ts'
import { runtime } from './runtime.ts'
import { sessions } from './sessions.ts'
import { ipc } from './file-ipc.ts'

test('findOpenSessionForCwd returns the first matching open tab', () => {
	const openSessions = [
		{ id: '04-other', cwd: '/work/other' },
		{ id: '04-first', cwd: '/work/project' },
		{ id: '04-second', cwd: '/work/project' },
	]

	expect(tabs.findOpenSessionForCwd(openSessions, '/work/project')).toBe('04-first')
})


test('focusing an ordinary tab avoids metadata and shared-state writes', () => {
	const originalOpenSessionIds = runtime.state.openSessionIds
	const originalCurrentSessionId = runtime.state.currentSessionId
	const originalLoadSessionMeta = sessions.loadSessionMeta
	const originalUpdateMeta = sessions.updateMeta
	const originalUpdateState = ipc.updateState
	let metaWrites = 0
	let stateWrites = 0
	runtime.state.openSessionIds = ['04-one']
	sessions.loadSessionMeta = (() => ({ id: '04-one', createdAt: '2026-08-27T00:00:00.000Z' })) as typeof sessions.loadSessionMeta
	sessions.updateMeta = (() => { metaWrites++ }) as typeof sessions.updateMeta
	ipc.updateState = (() => { stateWrites++ }) as unknown as typeof ipc.updateState
	try {
		tabs.focusSession('04-one')
		expect(runtime.state.currentSessionId).toBe('04-one')
		expect(metaWrites).toBe(0)
		expect(stateWrites).toBe(0)
	} finally {
		runtime.state.openSessionIds = originalOpenSessionIds
		runtime.state.currentSessionId = originalCurrentSessionId
		sessions.loadSessionMeta = originalLoadSessionMeta
		sessions.updateMeta = originalUpdateMeta
		ipc.updateState = originalUpdateState
	}
})


test('focusing a new tab clears only its attention marker', () => {
	const originalOpenSessionIds = runtime.state.openSessionIds
	const originalLoadSessionMeta = sessions.loadSessionMeta
	const originalUpdateMeta = sessions.updateMeta
	const originalUpdateState = ipc.updateState
	const shared: any = { sessions: [{ id: '04-one', attention: 'new' }, { id: '04-two', attention: 'new' }] }
	let metaUpdate: any
	runtime.state.openSessionIds = ['04-one', '04-two']
	sessions.loadSessionMeta = (() => ({ id: '04-one', createdAt: '2026-08-27T00:00:00.000Z', attention: 'new' })) as typeof sessions.loadSessionMeta
	sessions.updateMeta = ((sessionId, patch) => { metaUpdate = { sessionId, patch } }) as typeof sessions.updateMeta
	ipc.updateState = ((mutator) => { mutator(shared); return shared }) as typeof ipc.updateState
	try {
		tabs.focusSession('04-one')
		expect(metaUpdate).toEqual({ sessionId: '04-one', patch: { attention: undefined } })
		expect(shared.sessions).toEqual([{ id: '04-one', attention: undefined }, { id: '04-two', attention: 'new' }])
	} finally {
		runtime.state.openSessionIds = originalOpenSessionIds
		sessions.loadSessionMeta = originalLoadSessionMeta
		sessions.updateMeta = originalUpdateMeta
		ipc.updateState = originalUpdateState
	}
})

test('openSessionForCwd creates instead of resuming a dormant session', () => {
	const originalOpenSessionMetas = tabs.openSessionMetas
	const originalCreateSessionTab = tabs.createSessionTab
	const originalActivateSession = sessions.activateSession
	sessions.activateSession = () => {
		throw new Error('must not resume a dormant session')
	}
	let workingDir = ''
	tabs.openSessionMetas = () => []
	tabs.createSessionTab = ((opts: { workingDir?: string }) => {
		workingDir = opts.workingDir ?? ''
		return { id: '04-created' }
	}) as typeof tabs.createSessionTab

	try {
		expect(tabs.openSessionForCwd('/work/project')).toEqual({ ok: true, sessionId: '04-created' })
		expect(workingDir).toBe('/work/project')
	} finally {
		tabs.openSessionMetas = originalOpenSessionMetas
		tabs.createSessionTab = originalCreateSessionTab
		sessions.activateSession = originalActivateSession
	}
})

test('openSessionForCwd enforces the shared open-tab limit', () => {
	const originalOpenSessionMetas = tabs.openSessionMetas
	const originalMaxTabs = tabs.config.maxTabs
	const originalOpenSessionIds = runtime.state.openSessionIds
	runtime.state.openSessionIds = ['04-open']
	tabs.config.maxTabs = 1
	tabs.openSessionMetas = (() => [{ id: '04-open', workingDir: '/work/other' }]) as typeof tabs.openSessionMetas

	try {
		expect(tabs.openSessionForCwd('/work/project')).toEqual({
			ok: false,
			reason: 'Cannot open /work/project: max tabs reached (1). Close one first.',
		})
	} finally {
		tabs.openSessionMetas = originalOpenSessionMetas
		tabs.config.maxTabs = originalMaxTabs
		runtime.state.openSessionIds = originalOpenSessionIds
	}
})

test('rememberedTabForCwd prefers the remembered tab over the first tab with the same cwd', () => {
	const open = [
		{ id: '04-first', cwd: '/work/project' },
		{ id: '04-last', cwd: '/work/project' },
	]

	expect(tabs.rememberedTabForCwd({ restartTab: null, lastTab: '04-last' }, open, '/work/project')).toBe('04-last')
	expect(tabs.rememberedTabForCwd({ restartTab: '04-last', lastTab: null }, open, '/work/project')).toBe('04-last')
})

test('rememberedTabForCwd ignores a remembered tab that is closed or in another cwd', () => {
	const open = [{ id: '04-first', cwd: '/work/project' }]

	expect(tabs.rememberedTabForCwd({ restartTab: null, lastTab: '04-gone' }, open, '/work/project')).toBe(null)
	expect(tabs.rememberedTabForCwd({ restartTab: null, lastTab: '04-first' }, open, '/work/other')).toBe(null)
	expect(tabs.rememberedTabForCwd({ restartTab: null, lastTab: null }, open, '/work/project')).toBe(null)
})
