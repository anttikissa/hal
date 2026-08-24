import { expect, test, beforeEach } from 'bun:test'
import { router } from './router.ts'

// The router reads and writes the address bar through router.href/router.write,
// so these tests drive it without a DOM.
let written: Array<{ url: string; replace: boolean }> = []

function fakeBrowser(href: string): void {
	written = []
	router.href = () => href
	router.write = (url, replace) => {
		written.push({ url, replace })
		const next = new URL(url, href)
		router.href = () => next.href
	}
}

beforeEach(() => {
	fakeBrowser('https://hal.kissa.dev/')
	router.handlePopState()
})

test('parses the session id from the first path segment', () => {
	expect(router.parse('https://hal.kissa.dev/05-wan')).toBe('05-wan')
	expect(router.parse('https://hal.kissa.dev/112-bad')).toBe('112-bad')
})

test('treats the root and non-session paths as no session', () => {
	expect(router.parse('https://hal.kissa.dev/')).toBe('')
	expect(router.parse('https://hal.kissa.dev/styles.css')).toBe('')
	expect(router.parse('https://hal.kissa.dev/main.js')).toBe('')
	expect(router.parse('https://hal.kissa.dev/deep/link')).toBe('')
})

test('ignores query and hash when parsing', () => {
	expect(router.parse('https://hal.kissa.dev/05-wan?auth=secret#msg')).toBe('05-wan')
})

test('formats session ids back into paths', () => {
	expect(router.format('05-wan')).toBe('/05-wan')
	expect(router.format('')).toBe('/')
})

test('navigate pushes a history entry and updates the current session', () => {
	router.navigate('05-wan')
	expect(written).toEqual([{ url: '/05-wan', replace: false }])
	expect(router.sessionId()).toBe('05-wan')
})

test('navigate can replace instead of pushing', () => {
	router.navigate('05-wan', { replace: true })
	expect(written).toEqual([{ url: '/05-wan', replace: true }])
})

test('navigating to the current session does not add a duplicate history entry', () => {
	router.navigate('05-wan')
	router.navigate('05-wan')
	expect(written).toHaveLength(1)
})

test('back and forward reload the session from the address bar', () => {
	router.navigate('05-wan')
	fakeBrowser('https://hal.kissa.dev/05-fit')
	router.handlePopState()
	expect(router.sessionId()).toBe('05-fit')
})

test('start adopts the session the page was opened with', () => {
	fakeBrowser('https://hal.kissa.dev/05-wan')
	router.handlePopState()
	expect(router.sessionId()).toBe('05-wan')
})

test('takeSearchParam returns the value and strips it from the url', () => {
	fakeBrowser('https://hal.kissa.dev/05-wan?auth=secret')
	expect(router.takeSearchParam('auth')).toBe('secret')
	expect(written).toEqual([{ url: '/05-wan', replace: true }])
	expect(router.href()).toBe('https://hal.kissa.dev/05-wan')
})

test('takeSearchParam leaves the url alone when the param is absent', () => {
	fakeBrowser('https://hal.kissa.dev/05-wan')
	expect(router.takeSearchParam('auth')).toBe('')
	expect(written).toEqual([])
})
