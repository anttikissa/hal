import { expect, test } from 'bun:test'
import { startup } from './startup.ts'

test('planTarget uses an already-open tab in that directory first', () => {
	const plan = startup.planTarget({
		cwd: '/work/project',
		openSessions: [
			{ id: '04-other', cwd: '/work/other' },
			{ id: '04-open', cwd: '/work/project' },
		],
		allSessions: [
			{ id: '04-closed', workingDir: '/work/project', createdAt: '2026-04-01T00:00:00.000Z' },
		],
	})

	expect(plan).toEqual({ kind: 'use-open', sessionId: '04-open' })
})

test('planTarget resumes the first closed session in that directory before creating one', () => {
	const plan = startup.planTarget({
		cwd: '/work/project',
		openSessions: [{ id: '04-other', cwd: '/work/other' }],
		allSessions: [
			{ id: '04-newer', workingDir: '/work/project', createdAt: '2026-04-02T00:00:00.000Z' },
			{ id: '04-first', workingDir: '/work/project', createdAt: '2026-04-01T00:00:00.000Z' },
		],
	})

	expect(plan).toEqual({ kind: 'resume', sessionId: '04-first' })
})

test('planTarget refuses when a new tab would be required but the tab limit is reached', () => {
	const openSessions = Array.from({ length: startup.config.maxTabs }, (_, index) => ({
		id: `04-${index}`,
		cwd: `/work/${index}`,
	}))
	const plan = startup.planTarget({ cwd: '/work/project', openSessions, allSessions: [] })

	expect(plan.kind).toBe('refuse')
})
