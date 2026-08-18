#!/usr/bin/env bun
// Type-check an edited file in its nearest TypeScript project. We deliberately
// build the full configured program: include-only .d.ts files, aliases, and
// inherited options are all part of the file's real type-checking context.
// tsc cannot limit diagnostics to one source file, so filter its non-pretty
// diagnostic output before returning it to the edit tool.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { ason } from '../src/utils/ason.ts'

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

function findConfig(filePath: string): string | null {
	let directory = dirname(filePath)
	while (true) {
		const configPath = join(directory, 'tsconfig.json')
		if (existsSync(configPath)) return configPath

		const parent = dirname(directory)
		if (parent === directory) return null
		directory = parent
	}
}

function makeConfig(configPath: string, filePath: string): string {
	const directory = dirname(configPath)
	const tempPath = join(directory, `.hal-tsc-file-${process.pid}-${Date.now()}.json`)
	const config = ason.parse(readFileSync(configPath, 'utf-8'))
	if (!config || typeof config !== 'object' || Array.isArray(config)) fail(`error: invalid tsconfig: ${configPath}`)

	const object = config as Record<string, unknown>
	const files = object.files
	if (files !== undefined && !Array.isArray(files)) fail(`error: invalid files list in ${configPath}`)
	if (!('extends' in object) && files === undefined && !('include' in object)) object.include = ['**/*']
	object.files = [...(files ?? []), relative(directory, filePath)]
	writeFileSync(tempPath, JSON.stringify(object))
	return tempPath
}

function findTsc(directory: string): string {
	try {
		const packagePath = Bun.resolveSync('typescript/package.json', directory)
		const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'))
		const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.tsc
		const tscPath = typeof bin === 'string' ? resolve(dirname(packagePath), bin) : ''
		if (existsSync(tscPath)) return tscPath
	} catch {}

	return resolve(import.meta.dir, '../node_modules/typescript/bin/tsc')
}

function diagnosticFile(line: string): string | null {
	const match = line.match(/^(.*)\(\d+,\d+\): (?:error|warning|suggestion|message) TS\d+:/)
	return match?.[1] ?? null
}

function filterDiagnostics(output: string, filePath: string, configPaths: string[], cwd: string): string {
	const lines: string[] = []
	let keep = false

	for (const line of output.split('\n')) {
		const diagnosticPath = diagnosticFile(line)
		if (diagnosticPath) {
			const sourcePath = resolve(cwd, diagnosticPath)
			keep = sourcePath === filePath || configPaths.includes(sourcePath)
		} else if (/^(?:error|warning|suggestion|message) TS\d+:/.test(line)) {
			// Some configuration errors have no source file, but prevent a
			// meaningful check of the edited file and must not be hidden.
			keep = true
		}
		if (keep) lines.push(line)
	}

	return lines.join('\n').trim()
}

function runTsc(tscPath: string, args: string[], cwd: string): { exitCode: number; output: string } {
	const proc = Bun.spawnSync([process.execPath, tscPath, ...args], {
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const decoder = new TextDecoder()
	return {
		exitCode: proc.exitCode ?? 1,
		output: `${decoder.decode(proc.stdout)}${decoder.decode(proc.stderr)}`,
	}
}

function main(): void {
	const arg = process.argv[2]
	if (!arg) fail('usage: bun scripts/tsc-file.ts <file>')

	const filePath = resolve(process.cwd(), arg)
	if (!existsSync(filePath)) fail(`error: file not found: ${filePath}`)

	const configPath = findConfig(filePath)
	const projectDirectory = configPath ? dirname(configPath) : dirname(filePath)
	let result: { exitCode: number; output: string }
	let tempPath: string | null = null

	if (configPath) {
		tempPath = makeConfig(configPath, filePath)
		try {
			result = runTsc(findTsc(projectDirectory), ['-p', tempPath, '--noEmit', '--pretty', 'false'], projectDirectory)
		} finally {
			try {
				unlinkSync(tempPath)
			} catch {}
		}
	} else {
		result = runTsc(findTsc(projectDirectory), [filePath, '--noEmit', '--pretty', 'false'], projectDirectory)
	}

	const output = configPath ? filterDiagnostics(result.output, filePath, [configPath, tempPath!], projectDirectory) : result.output.trim()
	if (output) process.stderr.write(`${output}\n`)
	process.exit(output ? 1 : 0)
}

main()
