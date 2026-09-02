import { beforeEach, describe, expect, test } from 'bun:test'
import { webDraft } from './draft.ts'

class MemoryStorage {
	items = new Map<string, string>()

	getItem(key: string): string | null {
		return this.items.get(key) ?? null
	}

	setItem(key: string, value: string): void {
		this.items.set(key, value)
	}

	removeItem(key: string): void {
		this.items.delete(key)
	}
}

beforeEach(() => webDraft.state.pending.clear())

describe('web drafts', () => {
	test('preserves the exact draft independently for every session', () => {
		const storage = new MemoryStorage()
		webDraft.save('15-one', '  a long\nmessage  ', storage)
		webDraft.save('15-two', 'another draft', storage)

		expect(webDraft.load('15-one', storage)).toBe('  a long\nmessage  ')
		expect(webDraft.load('15-two', storage)).toBe('another draft')
	})

	test('clears a sent draft without destroying text typed while it was sending', () => {
		const storage = new MemoryStorage()
		webDraft.save('15-one', 'sent text', storage)
		expect(webDraft.clearIfUnchanged('15-one', 'sent text', storage)).toBe(true)
		expect(webDraft.load('15-one', storage)).toBe('')

		webDraft.save('15-one', 'sent text plus more', storage)
		expect(webDraft.clearIfUnchanged('15-one', 'sent text', storage)).toBe(false)
		expect(webDraft.load('15-one', storage)).toBe('sent text plus more')
	})

	test('removes empty drafts instead of leaving stale text behind', () => {
		const storage = new MemoryStorage()
		webDraft.save('15-one', 'old text', storage)
		webDraft.save('15-one', '', storage)
		expect(webDraft.load('15-one', storage)).toBe('')
	})

	test('keeps an in-page copy and refuses reload until a failed write is durable', () => {
		const storage = new MemoryStorage()
		let failing = true
		const unreliable = {
			getItem: (key: string) => storage.getItem(key),
			setItem: (key: string, value: string) => {
				if (failing) throw new Error('quota exceeded')
				storage.setItem(key, value)
			},
			removeItem: (key: string) => storage.removeItem(key),
		}

		expect(webDraft.save('15-one', 'irreplaceable', unreliable)).toBe(false)
		expect(webDraft.load('15-one', unreliable)).toBe('irreplaceable')
		expect(webDraft.isDurable()).toBe(false)

		failing = false
		expect(webDraft.flush(unreliable)).toBe(true)
		expect(webDraft.isDurable()).toBe(true)
		expect(webDraft.load('15-one', storage)).toBe('irreplaceable')
	})

	test('a later save retries pending drafts from other sessions', () => {
		const storage = new MemoryStorage()
		const unavailable = {
			getItem: (key: string) => storage.getItem(key),
			setItem: () => { throw new Error('unavailable') },
			removeItem: (key: string) => storage.removeItem(key),
		}
		expect(webDraft.save('15-one', 'first', unavailable)).toBe(false)

		expect(webDraft.save('15-two', 'second', storage)).toBe(true)
		expect(webDraft.isDurable()).toBe(true)
		expect(webDraft.load('15-one', storage)).toBe('first')
		expect(webDraft.load('15-two', storage)).toBe('second')
	})
})
