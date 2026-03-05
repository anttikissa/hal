import { describe, expect, test } from 'bun:test'
import {
	activityBarText,
	createTabState,
	sessionName,
	tabDisplayNames,
	titleBarText,
} from './tab.ts'

describe('tab helpers', () => {
	test('createTabState sets defaults', () => {
		const tab = createTabState({
			sessionId: 's-abc123',
			workingDir: '/tmp/project',
			name: 'project:abc123',
			modelLabel: 'Codex 5.3',
		})
		expect(tab).toEqual({
			sessionId: 's-abc123',
			workingDir: '/tmp/project',
			name: 'project:abc123',
			topic: '',
			modelLabel: 'Codex 5.3',
			output: '',
			fmtState: { prevKind: '', toolProgressLines: 0, termWidth: 80 },
			contextStatus: null,
			activity: '',
			busy: false,
			paused: false,
			inputHistory: [],
			inputDraft: '',
			inputCursor: 0,
			halIdleSince: expect.any(Number),
			toolBlockStart: null,
		})
	})

	test('activityBarText formats paused/busy/done', () => {
		const base = createTabState({
			sessionId: 's-abc123',
			workingDir: '/tmp/project',
			name: 'project:abc123',
			modelLabel: 'Codex 5.3',
		})
		expect(activityBarText({ ...base, paused: true })).toContain('Paused • Codex 5.3')
		expect(activityBarText({ ...base, busy: true, activity: 'Thinking' })).toBe('Codex 5.3 • Thinking')
		expect(activityBarText(base)).toBe('Done. • Codex 5.3')
	})

	test('sessionName prefers explicit then dir+short id fallback', () => {
		expect(sessionName({ id: 's-1234567890', name: '  My Tab  ', workingDir: '/x/y' })).toBe('My Tab')
		expect(sessionName({ id: 's-1234567890', name: '', workingDir: '/x/y' })).toBe('y:123456')
		expect(sessionName({ id: 's-1234567890', name: '', workingDir: '' })).toBe('s-123456')
	})

	test('tabDisplayNames dedupes same base names', () => {
		let i = 0
		const mk = (workingDir: string, name: string) =>
			createTabState({
				sessionId: `s-${++i}`,
				workingDir,
				name,
				modelLabel: 'Codex 5.3',
			})
		const names = tabDisplayNames([
			mk('/tmp/api', 'api:1'),
			mk('/work/api', 'api:2'),
			mk('/work/web', 'web:1'),
		])
		expect(names).toEqual(['api.1', 'api.2', 'web'])
	})

	test('titleBarText includes topic when present', () => {
		const tab = createTabState({
			sessionId: 's-abc12345',
			workingDir: '/tmp/project',
			name: 'project:abc123',
			modelLabel: 'Codex 5.3',
		})
		expect(titleBarText({ ...tab, topic: 'Refactor plan' })).toBe('Refactor plan — project:abc123')
		expect(titleBarText(tab)).toBe('project:abc123')
	})
})
