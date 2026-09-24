import { describe, expect, test } from 'bun:test'
import type { SharedSessionInfo } from '../../common/ipc.ts'
import { sessionActivity } from './session-activity.ts'

const session: SharedSessionInfo = { id: '05-work', tab: 3, name: 'Work', cwd: '/' }

describe('session activity', () => {
	test('matches terminal priority for foreground turn states', () => {
		expect(sessionActivity.describe(session, true, false)).toEqual({
			markers: [{ glyph: '▪', tone: 'running', animated: true }],
			label: 'working',
		})
		expect(sessionActivity.describe({ ...session, attention: 'new' }, true, false)).toEqual({
			markers: [{ glyph: '◆', tone: 'attention', animated: true }],
			label: 'working, new',
		})
		expect(sessionActivity.describe({ ...session, continuation: 'retry' }, false, false).markers[0]).toMatchObject({ glyph: '✗', tone: 'error' })
		expect(sessionActivity.describe({ ...session, continuation: 'continue' }, false, false).markers[0]).toMatchObject({ glyph: '!', tone: 'attention' })
	})

})

test('the tab strip pins the selected session, then working, attention, and finished tabs', () => {
	const sessions = [
		{ ...session, id: '01-idle', tab: 1 },
		{ ...session, id: '02-working', tab: 2 },
		{ ...session, id: '03-new', tab: 3, attention: 'new' as const },
		{ ...session, id: '04-current', tab: 4 },
		{ ...session, id: '05-working', tab: 5 },
		{ ...session, id: '06-idle', tab: 6 },
	]
	expect(sessionActivity.ordered(sessions, '04-current', { '02-working': true, '05-working': true }).map((item) => item.id)).toEqual([
		'04-current', '02-working', '05-working', '03-new', '01-idle', '06-idle',
	])
	expect(sessions[0]?.id).toBe('01-idle') // Do not reorder the source list or its tab numbers.
})

test('background summarization is also a working shortcut', () => {
	const sessions = [{ ...session, id: 'idle' }, { ...session, id: 'summary' }]
	expect(sessionActivity.ordered(sessions, 'none', {}, { summary: true })[0]?.id).toBe('summary')
})

test('50 sessions still expose the current and working ones in four phone slots', () => {
	const sessions = Array.from({ length: 50 }, (_, index) => ({ ...session, id: `tab-${index + 1}`, tab: index + 1 }))
	const slots = sessionActivity.capacity(248, 56, 4)
	expect(sessionActivity.ordered(sessions, 'tab-49', { 'tab-2': true, 'tab-37': true }).slice(0, slots).map((item) => item.tab)).toEqual([49, 2, 37, 1])
	expect(sessions).toHaveLength(50)
})

test('a crowded session list can be searched by number, name, ID, and cwd', () => {
	expect(sessionActivity.matches(session, '  3 ')).toBe(true)
	expect(sessionActivity.matches(session, 'work')).toBe(true)
	expect(sessionActivity.matches(session, '/')).toBe(true)
	expect(sessionActivity.matches(session, 'other')).toBe(false)
	expect(sessionActivity.matches({ ...session, tab: undefined }, '3', 3)).toBe(true)
})

test('the tab strip renders only complete focusable buttons that fit', () => {
	expect(sessionActivity.capacity(204, 48, 4)).toBe(4)
	expect(sessionActivity.capacity(203, 48, 4)).toBe(3)
	expect(sessionActivity.capacity(0, 48, 4)).toBe(1)
})
