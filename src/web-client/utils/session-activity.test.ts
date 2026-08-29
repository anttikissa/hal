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

	test('shows background summaries alongside turn activity', () => {
		expect(sessionActivity.describe(session, true, true)).toEqual({
			markers: [
				{ glyph: '▪', tone: 'running', animated: true },
				{ glyph: '▪', tone: 'background', animated: true },
			],
			label: 'working, summarizing',
		})
	})

	test('keeps idle and new sessions identifiable', () => {
		expect(sessionActivity.describe(session, false, false)).toEqual({ markers: [], label: 'idle' })
		expect(sessionActivity.describe({ ...session, attention: 'new' }, false, false)).toEqual({
			markers: [{ glyph: '◆', tone: 'attention', animated: false }],
			label: 'new',
		})
		expect(sessionActivity.shortName({ ...session, name: '' })).toBe('work')
		expect(sessionActivity.shortName(session)).toBe('Work')
	})
})
