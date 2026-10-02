import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import type { Tab } from '../common/protocol.ts'
import { projects } from './projects.ts'

let dir = mkdtempSync('/tmp/hal-projects-')
afterEach(() => {
	projects.state.roots.clear()
	projects.state.assigned.clear()
})
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

let tab = (cwd: string): Tab => ({ id: cwd, name: '', cwd, model: '', state: { type: 'idle' } as Tab['state'] })
let paint = (...cwds: string[]) => {
	let list = cwds.map(tab)
	projects.paint(list)
	return list.map((t) => t.color)
}

test('a subdirectory of a repo is the repo; dotted and plain names prefer one color', () => {
	mkdirSync(`${dir}/.hal/.git`, { recursive: true })
	mkdirSync(`${dir}/.hal/src`, { recursive: true })
	expect(projects.root(`${dir}/.hal/src`)).toBe(`${dir}/.hal`)
	expect(projects.preferred(`${dir}/.hal`, 8)).toBe(projects.preferred('/elsewhere/hal', 8))
})

test('one project shows no color; two get different colors that stay while open', () => {
	mkdirSync(`${dir}/a`, { recursive: true })
	mkdirSync(`${dir}/b`, { recursive: true })
	expect(paint(`${dir}/a`, `${dir}/a`)).toEqual([undefined, undefined])
	let [a, b] = paint(`${dir}/a`, `${dir}/b`)
	expect(a).not.toBe(b)
	// Closing the first tab and reopening it later keeps b's color.
	expect(paint(`${dir}/b`, `${dir}/a`)).toEqual([b, a])
})

test('a taken preference falls to the free color farthest from those in use', () => {
	expect(projects.pick(2, new Set([2]), 8)).toBe(6)
	expect(projects.pick(3, new Set([2]), 8)).toBe(3)
	expect(projects.pick(2, new Set([0, 1, 2, 3, 4, 5, 6, 7]), 8)).toBe(2)
})
