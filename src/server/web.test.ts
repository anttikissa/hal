import { expect, test } from 'bun:test'
import type { SharedState } from '../common/ipc.ts'
import { ipc } from '../ipc.ts'
import { sessions } from './sessions.ts'
import { web } from './web.ts'

test('web fallback port advances by a randomized exponential step', () => {
	expect(web.nextPort(9001, 1, () => 0)).toBe(9002)
	expect(web.nextPort(9001, 1, () => 0.99)).toBe(9003)
	expect(web.nextPort(9003, 2, () => 0)).toBe(9004)
})

test('web page keeps full-width tabs and composer visible around the scrolling transcript', () => {
	const page = web.pageHtml()
	expect(page).toMatch(/#tabs\s*\{[^}]*position:\s*fixed;[^}]*left:\s*0;[^}]*right:\s*0;/s)
	expect(page).toMatch(/#form\s*\{[^}]*position:\s*fixed;[^}]*bottom:\s*0;/s)
	expect(page).toMatch(/main\s*\{[^}]*max-width:\s*900px;[^}]*padding:\s*78px 12px 76px;/s)
	expect(page).not.toMatch(/body\s*\{[^}]*max-width:/s)
})

test('session snapshot exposes typed history and live blocks without lossy mapping', () => {
	const originalReadState = ipc.readState
	const originalLoadAllHistory = sessions.loadAllHistory
	const originalLoadLive = sessions.loadLive
	const state: SharedState = {
		sessions: [{ id: '04-work', tab: 1, name: 'work', cwd: '/work', model: 'openai/gpt-5.6-sol' }],
		working: { '04-work': true },
		updatedAt: '2026-08-13T12:00:00.000Z',
	}
	ipc.readState = () => state
	sessions.loadAllHistory = () => [{ type: 'user', parts: [{ type: 'text', text: 'hello' }], ts: '2026-08-13T11:59:00.000Z' }]
	sessions.loadLive = () => ({ blocks: [{ type: 'tool', name: 'read', toolId: 'tool-1', input: { path: 'README.md' }, running: true }] })
	try {
		expect(web.sessionSnapshot('04-work')).toEqual({
			session: state.sessions[0]!,
			history: [{ type: 'user', parts: [{ type: 'text', text: 'hello' }], ts: '2026-08-13T11:59:00.000Z' }],
			live: [{ type: 'tool', name: 'read', toolId: 'tool-1', input: { path: 'README.md' }, running: true }],
		})
		expect(web.sessionSnapshot('missing')).toBeNull()
	} finally {
		ipc.readState = originalReadState
		sessions.loadAllHistory = originalLoadAllHistory
		sessions.loadLive = originalLoadLive
	}
})
