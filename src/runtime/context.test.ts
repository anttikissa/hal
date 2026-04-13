import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { context } from './context.ts'

let tempDir = ''
let origHalDir = ''
let origStateDir = ''
let origHome = ''

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'hal-context-'))
	origHalDir = process.env.HAL_DIR ?? ''
	origStateDir = process.env.HAL_STATE_DIR ?? ''
	origHome = process.env.HOME ?? ''
	process.env.HAL_DIR = tempDir
	process.env.HAL_STATE_DIR = join(tempDir, 'state')
	process.env.HOME = tempDir
	mkdirSync(join(tempDir, 'state'), { recursive: true })
	context.__resetForTests()
})

afterEach(() => {
	context.__resetForTests()
	if (origHalDir) process.env.HAL_DIR = origHalDir
	else delete process.env.HAL_DIR
	if (origStateDir) process.env.HAL_STATE_DIR = origStateDir
	else delete process.env.HAL_STATE_DIR
	if (origHome) process.env.HOME = origHome
	else delete process.env.HOME
	rmSync(tempDir, { recursive: true, force: true })
})

test('buildSystemPrompt reads updated SYSTEM.md contents', () => {
	writeFileSync(join(tempDir, 'SYSTEM.md'), 'alpha\n')
	const cwd = join(tempDir, 'repo')
	mkdirSync(join(cwd, '.git'), { recursive: true })

	expect(context.buildSystemPrompt({ cwd, model: 'openai/gpt-5.4' }).text).toContain('alpha')

	writeFileSync(join(tempDir, 'SYSTEM.md'), 'beta\n')

	expect(context.buildSystemPrompt({ cwd, model: 'openai/gpt-5.4' }).text).toContain('beta')
})

test('prompt watcher reports SYSTEM.md edits', async () => {
	writeFileSync(join(tempDir, 'SYSTEM.md'), 'alpha\n')
	const cwd = join(tempDir, 'repo')
	mkdirSync(join(cwd, '.git'), { recursive: true })

	const seen: string[] = []
	const stop = context.watchPromptFiles([{ sessionId: 's1', cwd }], (change) => {
		seen.push(`${change.sessionId}:${change.name}`)
	})

	try {
		// fs.watch can miss an edit that lands immediately after registration on
		// some platforms. Give the watcher one short tick to attach first.
		await wait(100)
		writeFileSync(join(tempDir, 'SYSTEM.md'), 'beta\n')
		const deadline = Date.now() + 1500
		while (Date.now() < deadline && seen.length === 0) await wait(25)
		expect(seen).toContain('s1:SYSTEM.md')
	} finally {
		stop()
	}
})

test('prompt watcher reports AGENTS.md edits', async () => {
	writeFileSync(join(tempDir, 'SYSTEM.md'), 'base\n')
	const cwd = join(tempDir, 'repo', 'subdir')
	mkdirSync(join(tempDir, 'repo', '.git'), { recursive: true })
	mkdirSync(cwd, { recursive: true })
	writeFileSync(join(tempDir, 'repo', 'AGENTS.md'), 'rules\n')

	const seen: string[] = []
	const stop = context.watchPromptFiles([{ sessionId: 's1', cwd }], (change) => {
		seen.push(`${change.sessionId}:${change.name}`)
	})

	try {
		// Same race as above: let the watcher fully attach before mutating files.
		await wait(100)
		writeFileSync(join(tempDir, 'repo', 'AGENTS.md'), 'updated\n')
		const deadline = Date.now() + 1500
		while (Date.now() < deadline && seen.length === 0) await wait(25)
		expect(seen).toContain('s1:AGENTS.md')
	} finally {
		stop()
	}
})
