import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { systemPrompt } from './system-prompt.ts'

const saved = { userHome: systemPrompt.userHome }
let root = ''

beforeEach(() => {
	root = mkdtempSync(`${tmpdir()}/hal-system-`)
	systemPrompt.userHome = () => `${root}/home`
})

afterEach(() => {
	Object.assign(systemPrompt, saved)
	rmSync(root, { recursive: true, force: true })
})

const at = new Date(2026, 8, 26, 1, 52).getTime()

test('says who, when and where: date, cwd and model', () => {
	mkdirSync(`${root}/work`)
	let text = systemPrompt.build({ cwd: `${root}/work`, model: 'anthropic/claude-x', now: at })
	expect(text).toContain('2026-09-26')
	expect(text).toContain(`${root}/work`)
	expect(text).toContain('anthropic/claude-x')
	expect(text).toMatch(/Hal/)
})

test('AGENTS.md files from the cwd upwards and the home one, outermost first, each once', () => {
	mkdirSync(`${root}/home`)
	mkdirSync(`${root}/a/b/c`, { recursive: true })
	writeFileSync(`${root}/home/AGENTS.md`, 'HOME RULE')
	writeFileSync(`${root}/a/AGENTS.md`, 'OUTER RULE')
	writeFileSync(`${root}/a/b/c/AGENTS.md`, 'INNER RULE')
	let text = systemPrompt.build({ cwd: `${root}/a/b/c`, model: 'm/x', now: at })
	let order = ['HOME RULE', 'OUTER RULE', 'INNER RULE'].map((s) => text.indexOf(s))
	expect(order.every((i) => i >= 0)).toBe(true)
	expect([...order].sort((x, y) => x - y)).toEqual(order)
	expect(text).toContain(`${root}/a/AGENTS.md`)
	// The home on the cwd's path is not read twice.
	mkdirSync(`${root}/home/proj`)
	let inside = systemPrompt.build({ cwd: `${root}/home/proj`, model: 'm/x', now: at })
	expect(inside.split('HOME RULE')).toHaveLength(2)
})

test('the same inputs give the same text; a changed input changes it', () => {
	mkdirSync(`${root}/work`)
	let input = { cwd: `${root}/work`, model: 'm/x', now: at }
	let first = systemPrompt.build(input)
	expect(systemPrompt.build({ ...input, now: at + 60_000 })).toBe(first)
	writeFileSync(`${root}/work/AGENTS.md`, 'NEW RULE')
	expect(systemPrompt.build(input)).toContain('NEW RULE')
	expect(systemPrompt.build({ ...input, now: at + 86_400_000 })).not.toBe(first)
})

test('a missing cwd still gives a prompt', () => {
	expect(systemPrompt.build({ cwd: `${root}/gone`, model: 'm/x', now: at })).toContain(`${root}/gone`)
})
