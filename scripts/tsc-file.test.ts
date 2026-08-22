import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const script = join(import.meta.dir, 'tsc-file.ts')
const directories: string[] = []

function makeProject(): string {
	const directory = mkdtempSync(join(tmpdir(), 'hal-tsc-file-'))
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

// Spawns a real tsc: fast locally, but the first spawn also warms Bun's module
// cache and can exceed the default 5s per-test timeout on a slow shared CI
// runner. The test asserts on tsc's diagnostics, not on how fast the box is.
test('uses the nearest configured project but reports only the edited file', () => {
	const project = makeProject()
	mkdirSync(join(project, 'config'))
	write(
		join(project, 'config', 'base.json'),
		JSON.stringify({
			compilerOptions: {
				noEmit: true,
				paths: { '@app/*': ['../src/*'] },
				strict: true,
			},
		}),
	)
	write(join(project, 'tsconfig.json'), JSON.stringify({ extends: './config/base.json', include: ['src/**/*.ts'] }))
	write(join(project, 'src', 'globals.d.ts'), 'declare const configuredGlobal: string\n')
	write(join(project, 'src', 'value.ts'), 'export const value = 1\n')
	write(
		join(project, 'draft.ts'),
		"import { value } from '@app/value'\nconst globalValue: string = configuredGlobal\nconst wrong: string = value\n",
	)
	write(join(project, 'src', 'unrelated.ts'), "const unrelated: number = 'wrong'\n")

	const result = run(join(project, 'draft.ts'), project)

	expect(result.exitCode).toBe(1)
	expect(result.output).toContain('draft.ts(3,7): error TS2322')
	expect(result.output).not.toContain('unrelated.ts')
	expect(result.output).not.toContain("Cannot find name 'configuredGlobal'")
	expect(result.output).not.toContain("Cannot find module '@app/value'")
}, 30_000)

test('checks a file without a tsconfig using TypeScript defaults', () => {
	const project = makeProject()
	const file = join(project, 'edited.ts')
	write(file, "const wrong: number = 'wrong'\n")

	const result = run(file, project)

	expect(result.exitCode).toBe(1)
	expect(result.output).toContain('Type \'string\' is not assignable to type \'number\'.')
})

test('reports diagnostics from the selected project config', () => {
	const project = makeProject()
	const file = join(project, 'edited.ts')
	write(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { notARealOption: true } }))
	write(file, 'export const value = 1\n')

	const result = run(file, project)

	expect(result.exitCode).toBe(1)
	expect(result.output).toContain("Unknown compiler option 'notARealOption'.")
})

test('prefers the project local TypeScript compiler', () => {
	const project = makeProject()
	const file = join(project, 'edited.ts')
	mkdirSync(join(project, 'node_modules', 'typescript', 'bin'), { recursive: true })
	write(join(project, 'tsconfig.json'), '{}')
	write(file, 'export const value = 1\n')
	write(join(project, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ bin: { tsc: 'bin/tsc.js' } }))
	write(
		join(project, 'node_modules', 'typescript', 'bin', 'tsc.js'),
		"console.error('edited.ts(1,1): error TS9999: local compiler')\nprocess.exit(1)\n",
	)

	const result = run(file, project)

	expect(result.exitCode).toBe(1)
	expect(result.output).toContain('error TS9999: local compiler')
})

test('preserves the default include when adding an edited file', () => {
	const project = makeProject()
	const file = join(project, 'edited.ts')
	write(join(project, 'tsconfig.json'), '{}')
	write(join(project, 'globals.d.ts'), 'declare const configuredGlobal: string\n')
	write(file, 'const value: string = configuredGlobal\n')
	write(join(project, 'unrelated.ts'), "const unrelated: number = 'wrong'\n")

	const result = run(file, project)

	expect(result.exitCode).toBe(0)
	expect(result.output).toBe('')
})
