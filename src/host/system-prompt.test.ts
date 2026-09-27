import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { systemPrompt } from './system-prompt.ts'

let root = ''

beforeEach(() => {
	root = mkdtempSync(`${tmpdir()}/hal-system-`)
})

afterEach(() => {
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

test('AGENTS.md files from the cwd upwards, outermost first; none from elsewhere', () => {
	mkdirSync(`${root}/a/b/c`, { recursive: true })
	mkdirSync(`${root}/elsewhere`)
	writeFileSync(`${root}/elsewhere/AGENTS.md`, 'OTHER RULE')
	writeFileSync(`${root}/a/AGENTS.md`, 'OUTER RULE')
	writeFileSync(`${root}/a/b/c/AGENTS.md`, 'INNER RULE')
	let text = systemPrompt.build({ cwd: `${root}/a/b/c`, model: 'm/x', now: at })
	let outer = text.indexOf('OUTER RULE'), inner = text.indexOf('INNER RULE')
	expect(outer).toBeGreaterThanOrEqual(0)
	expect(inner).toBeGreaterThan(outer)
	expect(text).toContain(`${root}/a/AGENTS.md`)
	expect(text).not.toContain('OTHER RULE')
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
