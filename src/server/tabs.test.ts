import { expect, test } from 'bun:test'
import { tabs } from './tabs.ts'
import { runtime } from './runtime.ts'
import { sessions } from './sessions.ts'

test('findOpenSessionForCwd returns the first matching open tab', () => {
	const openSessions = [
		{ id: '04-other', cwd: '/work/other' },
		{ id: '04-first', cwd: '/work/project' },
		{ id: '04-second', cwd: '/work/project' },
	]

	expect(tabs.findOpenSessionForCwd(openSessions, '/work/project')).toBe('04-first')
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
