import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadSystemPrompt, systemPrompt } from './system-prompt.ts'

const tmpDirs: string[] = []

afterEach(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
	tmpDirs.length = 0
})

function tempProject(): string {
	const dir = mkdtempSync(join(tmpdir(), 'hal-system-prompt-'))
	tmpDirs.push(dir)
	mkdirSync(join(dir, '.git'))
	return dir
}

test('loads SYSTEM.md with variable substitution', () => {
	const result = loadSystemPrompt({ model: 'claude-sonnet-4-20250514', sessionDir: 'test-session' })
	expect(result.text.length).toBeGreaterThan(100)
	expect(result.bytes).toBeGreaterThan(100)
	expect(result.loaded.some(f => f.name === 'SYSTEM.md')).toBe(true)
	expect(result.text).not.toContain('${model}')
	expect(result.text).not.toContain('${date}')
	expect(result.text).not.toContain('${hal_dir}')
	expect(result.text).toContain('claude-sonnet-4-20250514')
})

test('strips HTML comments', () => {
	const { text } = loadSystemPrompt()
	expect(text).not.toMatch(/<!--/)
})

test('collapses triple newlines', () => {
	const { text } = loadSystemPrompt()
	expect(text).not.toMatch(/\n{3,}/)
})

test('processes ::: if directives', () => {
	const { text } = loadSystemPrompt({ model: 'claude-sonnet-4-20250514' })
	expect(text).not.toMatch(/^:{3,}\s+if/m)
})

test('teaches blob placeholders and read_blob', () => {
	const { text } = loadSystemPrompt()
	expect(text).toContain('blob <id>')
	expect(text).toContain('read_blob')
})

test('finds git root by walking up', () => {
	const root = tempProject()
	const deep = join(root, 'a', 'b', 'c')
	mkdirSync(deep, { recursive: true })
	expect(systemPrompt.findGitRoot(deep)).toBe(root)
})

test('collects AGENTS.md chain with CLAUDE.md fallback', () => {
	const root = tempProject()
	const pkg = join(root, 'pkg')
	const app = join(pkg, 'app')
	mkdirSync(app, { recursive: true })
	writeFileSync(join(root, 'AGENTS.md'), 'root')
	writeFileSync(join(pkg, 'CLAUDE.md'), 'pkg')
	writeFileSync(join(app, 'AGENTS.md'), 'app')
	const files = systemPrompt.collectAgentFiles(app)
	expect(files.map(f => f.name)).toEqual(['AGENTS.md', 'CLAUDE.md', 'AGENTS.md'])
	expect(files.map(f => f.path)).toEqual([
		join(root, 'AGENTS.md'),
		join(pkg, 'CLAUDE.md'),
		join(app, 'AGENTS.md'),
	])
})

test('prefers AGENTS.md over CLAUDE.md in same directory', () => {
	const root = tempProject()
	writeFileSync(join(root, 'AGENTS.md'), 'agent')
	writeFileSync(join(root, 'CLAUDE.md'), 'claude')
	const files = systemPrompt.collectAgentFiles(root)
	expect(files).toHaveLength(1)
	expect(files[0]?.name).toBe('AGENTS.md')
})
