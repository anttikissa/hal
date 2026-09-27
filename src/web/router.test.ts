import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Tab } from '../common/protocol.ts'
import { router } from './router.ts'

const orig = { href: router.href, write: router.write, load: router.store.load }
let address = 'http://h/'
let writes: { url: string; replace: boolean }[] = []
let last: string | undefined

beforeEach(() => {
	address = 'http://h/'
	writes = []
	last = undefined
	router.href = () => address
	router.write = (url, replace) => {
		writes.push({ url, replace })
		address = new URL(url, address).href
	}
	router.store.load = () => last
})

afterEach(() => {
	router.href = orig.href
	router.write = orig.write
	router.store.load = orig.load
})

const tabs = (...ids: string[]): Tab[] => ids.map((id) => ({ id, name: id, cwd: '/w', model: 'm', state: { type: 'idle' } }))

test('the address names a tab only when shaped like a session id', () => {
	expect(router.parse('http://h/12-abc')).toBe('12-abc')
	expect(router.parse('http://h/12-abc?x=1#y')).toBe('12-abc')
	expect(router.parse('http://h/')).toBeUndefined()
	expect(router.parse('http://h/session')).toBeUndefined()
	expect(router.parse('http://h/12-abc/more')).toBeUndefined()
	expect(router.parse(`http://h${router.format('3-xyz')}`)).toBe('3-xyz')
})

test('an open wanted tab wins; otherwise the tab shown last, else the first', () => {
	let open = tabs('1-aaa', '2-bbb', '3-ccc')
	expect(router.pick(open, '2-bbb')).toBe('2-bbb')
	expect(router.pick(open, undefined)).toBe('1-aaa')
	expect(router.pick(open, '9-zzz')).toBe('1-aaa')
	last = '3-ccc'
	expect(router.pick(open, '9-zzz')).toBe('3-ccc')
	last = '8-yyy'
	expect(router.pick(open, undefined)).toBe('1-aaa')
	expect(router.pick([], undefined)).toBeUndefined()
})

test('when the shown tab closes, its neighbour shows', () => {
	let before = tabs('1-aaa', '2-bbb', '3-ccc')
	last = '1-aaa'
	expect(router.pick(tabs('1-aaa', '3-ccc'), '2-bbb', before)).toBe('3-ccc')
	expect(router.pick(tabs('1-aaa', '2-bbb'), '3-ccc', before)).toBe('2-bbb')
})

test('choosing a tab pushes an entry, landing replaces it, the same address writes nothing', () => {
	router.go('1-aaa', true)
	router.go('2-bbb', false)
	router.go('2-bbb', false)
	expect(writes).toEqual([
		{ url: '/1-aaa', replace: true },
		{ url: '/2-bbb', replace: false },
	])
	expect(router.parse(router.href())).toBe('2-bbb')
})
