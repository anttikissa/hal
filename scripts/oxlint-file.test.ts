import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const script = join(import.meta.dir, 'oxlint-file.ts')
const directories: string[] = []

function makeProject(): string {
	const directory = mkdtempSync(join(tmpdir(), 'hal-oxlint-file-'))
	directories.push(directory)
	mkdirSync(join(directory, 'src'))
	return directory
}

function write(path: string, content: string): void {
	writeFileSync(path, content)
}

function run(file: string, cwd: string): { exitCode: number; output: string } {
	const proc = Bun.spawnSync([process.execPath, script, file], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const decoder = new TextDecoder()
	return {
		exitCode: proc.exitCode ?? 1,
		output: `${decoder.decode(proc.stdout)}${decoder.decode(proc.stderr)}`,
	}
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

test('skips files outside a configured lint project', () => {
	const project = makeProject()
	const file = join(project, 'src', 'edited.ts')
	write(file, 'console.log("allowed without a project lint config")\n')

	const result = run(file, project)

	expect(result.exitCode).toBe(0)
	expect(result.output).toBe('')
})

test('uses the nearest parent lint config', () => {
	const project = makeProject()
	const file = join(project, 'src', 'edited.ts')
	write(join(project, '.oxlintrc.json'), JSON.stringify({ rules: { 'no-console': 'error' } }))
	write(file, 'console.log("configured")\n')

	const result = run(file, project)

	expect(result.exitCode).toBe(1)
	expect(result.output).toContain('eslint(no-console)')
})

test('prefers the project local oxlint binary', () => {
	const project = makeProject()
	const file = join(project, 'src', 'edited.ts')
	const binary = join(project, 'node_modules', 'oxlint', 'bin', 'oxlint')
	mkdirSync(join(project, 'node_modules', 'oxlint', 'bin'), { recursive: true })
	write(join(project, '.oxlintrc.json'), '{}')
	write(join(project, 'node_modules', 'oxlint', 'package.json'), JSON.stringify({ bin: { oxlint: 'bin/oxlint' } }))
	write(binary, '#!/bin/sh\necho "local oxlint $PWD:$1"\nexit 1\n')
	chmodSync(binary, 0o755)
	write(file, 'export const value = 1\n')

	const result = run(file, project)

	expect(result.exitCode).toBe(1)
	expect(result.output).toContain('local oxlint')
	expect(result.output).toContain(`${project}:src/edited.ts`)
})
