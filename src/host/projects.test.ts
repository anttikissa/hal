import { afterEach, expect, test } from 'bun:test'
import type { Tab } from '../common/protocol.ts'
import { projects } from './projects.ts'

afterEach(() => {
	projects.state.assigned.clear()
})

let tab = (cwd: string): Tab => ({ id: cwd, name: '', cwd, model: '', state: { type: 'idle' } as Tab['state'] })
let paint = (...cwds: string[]) => {
	let list = cwds.map(tab)
	projects.paint(list)
	return list.map((t) => t.color)
}

test('dotted and plain names prefer one color; a nested project differs from its parent', () => {
	expect(projects.preferred('/root/.hal', 8)).toBe(projects.preferred('/elsewhere/hal', 8))
	let [outer, inner] = paint('/p/a', '/p/a/b')
	expect(outer).not.toBe(inner)
})

test('one project shows no color; two get different colors that stay while open', () => {
	expect(paint('/p/a', '/p/a')).toEqual([undefined, undefined])
	let [a, b] = paint('/p/a', '/p/b')
	expect(a).not.toBe(b)
	// Closing the first tab and reopening it later keeps b's color.
	expect(paint('/p/b', '/p/a')).toEqual([b, a])
})

test('a taken preference falls to the free color farthest from those in use', () => {
	expect(projects.pick(2, new Set([2]), 8)).toBe(6)
	expect(projects.pick(3, new Set([2]), 8)).toBe(3)
	expect(projects.pick(2, new Set([0, 1, 2, 3, 4, 5, 6, 7]), 8)).toBe(2)
})
