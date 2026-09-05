import { afterEach, expect, test } from 'bun:test'
import { appActions } from './app-actions.ts'
import { webDraft } from './draft.ts'

const original = { ...appActions }
const flush = webDraft.flush

afterEach(() => {
	Object.assign(appActions, original)
	webDraft.flush = flush
})

test('detects installed iOS and standard standalone apps, not ordinary browser tabs', () => {
	expect(appActions.isInstalled({ standalone: true }, () => ({ matches: false }))).toBe(true)
	expect(appActions.isInstalled({}, (query) => ({ matches: query === '(display-mode: standalone)' }))).toBe(true)
	expect(appActions.isInstalled({ standalone: false }, () => ({ matches: false }))).toBe(false)
})

test('refresh refuses unsaved drafts and reloads only after successful persistence', () => {
	let reloads = 0
	appActions.reload = () => { reloads++ }
	webDraft.flush = () => false
	expect(appActions.refresh()).toBe(false)
	expect(reloads).toBe(0)
	webDraft.flush = () => true
	expect(appActions.refresh()).toBe(true)
	expect(reloads).toBe(1)
})
