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

test('in Git, one file per directory from the repo root down to the cwd, outermost first', () => {
	mkdirSync(`${root}/repo/.git`, { recursive: true })
	mkdirSync(`${root}/repo/b/c`, { recursive: true })
	writeFileSync(`${root}/AGENTS.md`, 'ABOVE REPO')
	writeFileSync(`${root}/repo/AGENTS.md`, 'OUTER RULE')
	writeFileSync(`${root}/repo/b/CLAUDE.md`, 'MIDDLE CLAUDE')
	writeFileSync(`${root}/repo/b/c/AGENTS.md`, 'INNER RULE')
	writeFileSync(`${root}/repo/b/c/CLAUDE.md`, 'INNER CLAUDE')
	let text = systemPrompt.build({ cwd: `${root}/repo/b/c`, model: 'm/x', now: at })
	let outer = text.indexOf('OUTER RULE'), middle = text.indexOf('MIDDLE CLAUDE'), inner = text.indexOf('INNER RULE')
	expect(outer).toBeGreaterThanOrEqual(0)
	expect(middle).toBeGreaterThan(outer)
	expect(inner).toBeGreaterThan(middle)
	expect(text).toContain(`${root}/repo/AGENTS.md`)
	expect(text).toContain(`${root}/repo/b/CLAUDE.md`)
	// AGENTS.md wins over CLAUDE.md in the same directory; nothing above the repo.
	expect(text).not.toContain('INNER CLAUDE')
	expect(text).not.toContain('ABOVE REPO')
})

test('outside Git only the cwd itself is read', () => {
	mkdirSync(`${root}/a/b`, { recursive: true })
	writeFileSync(`${root}/a/AGENTS.md`, 'PARENT RULE')
	writeFileSync(`${root}/a/b/CLAUDE.md`, 'HERE RULE')
	let text = systemPrompt.build({ cwd: `${root}/a/b`, model: 'm/x', now: at })
	expect(text).toContain('HERE RULE')
	expect(text).not.toContain('PARENT RULE')
})

test('the date names the UTC offset of the clock prompt stamps use', () => {
	let tz = process.env.TZ
	try {
		let noon = Date.UTC(2026, 8, 26, 21, 30)
		process.env.TZ = 'UTC'
		expect(systemPrompt.build({ cwd: root, model: 'm/x', now: noon })).toMatch(/2026-09-26, Saturday\b.*UTC(?![+-])/)
		process.env.TZ = 'Asia/Kolkata'
		expect(systemPrompt.build({ cwd: root, model: 'm/x', now: noon })).toMatch(/2026-09-27, Sunday\b.*UTC\+05:30/)
	} finally {
		if (tz === undefined) delete process.env.TZ
		else process.env.TZ = tz
	}
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

test('the checkout SYSTEM.md opens the prompt: it says who Hal is', () => {
	expect(systemPrompt.build({ cwd: root, model: 'm/x', now: at })).toMatch(/^You are Hal\b/)
})

test('SYSTEM.md is read per build: an edit shows on the next one, no edit keeps the text', () => {
	let orig = systemPrompt.file
	try {
		systemPrompt.file = () => `${root}/SYSTEM.md`
		writeFileSync(`${root}/SYSTEM.md`, 'You are Hal.\n- FIRST RULE\n')
		let input = { cwd: `${root}/gone`, model: 'm/x', now: at }
		let first = systemPrompt.build(input)
		expect(first.startsWith('You are Hal.\n- FIRST RULE')).toBe(true)
		expect(systemPrompt.build(input)).toBe(first)
		writeFileSync(`${root}/SYSTEM.md`, 'You are Hal.\n- SECOND RULE\n')
		let second = systemPrompt.build(input)
		expect(second).toContain('SECOND RULE')
		expect(second).not.toContain('FIRST RULE')
		rmSync(`${root}/SYSTEM.md`)
		expect(() => systemPrompt.build(input)).toThrow(`${root}/SYSTEM.md`)
	} finally {
		systemPrompt.file = orig
	}
})
