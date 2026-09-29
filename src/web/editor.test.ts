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

test('splice finds the smallest replacement between two texts, never splitting a surrogate pair', () => {
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
	expect(editor.splice('👍🏽', '👍🏿')).toEqual({ start: 2, end: 4, text: '🏿' })
	expect(editor.splice('\u{1F600}', '\u{1F601}')).toEqual({ start: 0, end: 2, text: '\u{1F601}' })
})

test('writing back an unchanged text leaves the box alone', () => {
	// A browser's execCommand('delete') on a caret deletes backwards.
	let box = { value: 'see [image/abc123.png]', selectionStart: 22, selectionEnd: 22, focus() {}, setSelectionRange(a: number, b: number) { box.selectionStart = a; box.selectionEnd = b } }
	let doc = globalThis as any
	let had = doc.document
	doc.document = {
		execCommand(cmd: string, _: boolean, text: string) {
			let { selectionStart: a, selectionEnd: b, value } = box
			if (cmd === 'delete' && a === b) a = Math.max(0, a - 1)
			box.value = value.slice(0, a) + (cmd === 'insertText' ? text : '') + value.slice(b)
			return true
		},
	}
	try {
		editor.write(box as any, editor.splice(box.value, box.value), 22)
		expect(box.value).toBe('see [image/abc123.png]')
	} finally {
		doc.document = had
	}
})
