import { expect, test } from 'bun:test'
import { editor } from './editor.ts'

test('only the keys whose meaning differs from a textarea leave native editing', () => {
	let routed = (key: string, mods = {}) => editor.routed({ key, ...mods })
	for (let k of ['k', 'u', 'y']) {
		expect(routed(k, { ctrl: true })).toBe(true)
		expect(routed(k)).toBe(false)
		expect(routed(k, { cmd: true })).toBe(false)
	}
	expect(routed('d', { alt: true })).toBe(true)
	expect(routed('d', { ctrl: true })).toBe(false)
	expect(routed('backspace', { alt: true })).toBe(true)
	// Native already matches: typing, arrows and word moves, deleting, undo.
	for (let [k, mods] of [['a', {}], ['left', { alt: true }], ['right', { cmd: true }], ['backspace', {}], ['home', {}], ['z', { cmd: true }], ['a', { ctrl: true }]] as const) expect(routed(k, mods)).toBe(false)
})

test('splice finds the smallest replacement between two texts', () => {
	let apply = (before: string, after: string) => {
		let s = editor.splice(before, after)
		return before.slice(0, s.start) + s.text + before.slice(s.end)
	}
	let pairs = [
		['hello world', 'hello '],
		['ab\ncd', 'abcd'],
		['abcd', 'abcdcd'],
		['aaa', 'aaaa'],
		['', 'x'],
		['x', ''],
		['same', 'same'],
		['a👍🏽b', 'ab'],
	]
	for (let [before, after] of pairs) expect(apply(before!, after!)).toBe(after!)
	expect(editor.splice('hello world', 'hello ')).toEqual({ start: 6, end: 11, text: '' })
	expect(editor.splice('ab', 'aXb')).toEqual({ start: 1, end: 1, text: 'X' })
})

test('a surrogate pair is never split by splice', () => {
	let s = editor.splice('👍🏽', '👍🏿')
	expect(s).toEqual({ start: 2, end: 4, text: '🏿' })
	let t = editor.splice('\u{1F600}', '\u{1F601}')
	expect(t).toEqual({ start: 0, end: 2, text: '\u{1F601}' })
})
