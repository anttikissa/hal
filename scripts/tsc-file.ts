#!/usr/bin/env bun
// Type-check one edited TypeScript file using the semantics of its nearest
// tsconfig.json. Usage: bun scripts/tsc-file.ts <file>
//
// Why this is not simply `tsc <file>`:
// - passing a file directly makes tsc ignore tsconfig.json;
// - narrowing `files`/`include` loses project-wide globals and augmentations;
// - running `tsc -p` preserves that context, but checks every included source.
//
// TypeScript 7's diagnostics API gives us the useful middle ground. We load the
// complete configured Program, then request syntax, binding, and semantic
// diagnostics only for the edited file. All configured roots are still present,
// so globals, module augmentations, aliases, references, inherited options, and
// imported types behave as they do in the real project. Unrelated files are not
// semantically checked, and reverse dependents of the edited file are outside
// this fast check; the project's full typecheck remains authoritative for them.
//
// Compiler selection and compatibility:
// - prefer the target project's TypeScript, matching its CI/build semantics;
// - use Hal's TypeScript only when the project has no local installation;
// - fall back to the full-project CLI path when the TypeScript 7 unstable API is
//   unavailable or changes incompatibly. The fallback is slower but correct.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { ason } from '../src/utils/ason.ts'
import type { Diagnostic } from 'typescript/unstable/async'

type TypeScript = {
	tscPath: string
	apiPath: string | null
}

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

// The temporary config lives beside the real config, so every relative path has
// exactly the same base directory. It retains the original root set and adds the
// edited file, which may be a new draft not yet matched by `include`.
//
// TypeScript's implicit `include: ["**/*"]` applies only while both `files` and
// `include` are absent. Materialize that default before adding `files`, otherwise
// an ordinary config such as `{}` would accidentally lose every existing root.
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

// Resolve both entry points from one package. The unstable JavaScript client
// starts its matching native TypeScript server, so mixing API and compiler
// versions would risk protocol and diagnostic differences.
function resolveTypeScript(directory: string): TypeScript | null {
	try {
		const packagePath = Bun.resolveSync('typescript/package.json', directory)
		const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'))
		const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.tsc
		const tscPath = typeof bin === 'string' ? resolve(dirname(packagePath), bin) : ''
		if (!existsSync(tscPath)) return null

		let apiPath: string | null = null
		try {
			apiPath = Bun.resolveSync('typescript/unstable/async', directory)
		} catch {}
		return { tscPath, apiPath }
	} catch {
		return null
	}
}

function findTypeScript(directory: string): TypeScript {
	return resolveTypeScript(directory) ?? resolveTypeScript(resolve(import.meta.dir, '..'))!
}

function diagnosticFile(line: string): string | null {
	const match = line.match(/^(.*)\(\d+,\d+\): (?:error|warning|suggestion|message) TS\d+:/)
	return match?.[1] ?? null
}

// Older compilers expose only the CLI, whose project mode emits diagnostics for
// the whole Program. Keep edited-file diagnostics, their continuation lines,
// and config/global diagnostics that have no source path; discard pre-existing
// errors from unrelated files.
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

function runTsc(tscPath: string, args: string[], cwd: string): string {
	const proc = Bun.spawnSync([process.execPath, tscPath, ...args], {
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const decoder = new TextDecoder()
	return `${decoder.decode(proc.stdout)}${decoder.decode(proc.stderr)}`
}

function runConfiguredTsc(tscPath: string, tempPath: string, filePath: string, configPath: string, cwd: string): string {
	const output = runTsc(tscPath, ['-p', tempPath, '--noEmit', '--pretty', 'false'], cwd)
	return filterDiagnostics(output, filePath, [configPath, tempPath], cwd)
}

// Loading a snapshot constructs the complete Program. The file arguments on the
// last three calls constrain the actual parse/bind/type diagnostics to the edit.
// Config-file and Program diagnostics are retained because invalid options or an
// invalid root set can make any per-file result misleading. We intentionally do
// not request project-wide global diagnostics, suggestions, or declaration emit
// diagnostics: they are either expensive, non-failing editor advice, or
// irrelevant to this no-emit check.
async function runApi(apiPath: string, configPath: string, filePath: string, cwd: string): Promise<Diagnostic[]> {
	const module = (await import(apiPath)) as typeof import('typescript/unstable/async')
	const api = new module.API({ cwd })
	try {
		const snapshot = await api.updateSnapshot({ openProjects: [configPath] })
		const project = snapshot.getProject(configPath)
		if (!project) throw new Error(`TypeScript did not load ${configPath}`)

		const program = project.program
		return [
			...(await program.getConfigFileParsingDiagnostics()),
			...(await program.getProgramDiagnostics()),
			...(await program.getSyntacticDiagnostics(filePath)),
			...(await program.getBindDiagnostics(filePath)),
			...(await program.getSemanticDiagnostics(filePath)),
		]
	} finally {
		await api.close()
	}
}

function messageText(diagnostic: Diagnostic, indentation = ''): string {
	let text = diagnostic.text
	for (const child of diagnostic.messageChain ?? []) {
		text += `\n${indentation}  ${messageText(child, `${indentation}  `)}`
	}
	return text
}

// Match tsc's non-pretty location format so the edit tool and humans receive
// familiar output. Diagnostics against the generated config are attributed to
// the real tsconfig, and related information is preserved even when it points
// into a dependency because it often explains the edited-file error.
function formatDiagnostic(diagnostic: Diagnostic, cwd: string, configPath: string, tempPath: string): string {
	const categories = ['warning', 'error', 'suggestion', 'message']
	const category = categories[diagnostic.category] ?? 'error'
	let location = ''

	if (diagnostic.fileName) {
		const sourcePath = resolve(cwd, diagnostic.fileName)
		const displayPath = sourcePath === tempPath ? configPath : sourcePath
		location = relative(cwd, displayPath) || displayPath
		if (diagnostic.pos >= 0 && existsSync(sourcePath)) {
			const prefix = readFileSync(sourcePath, 'utf-8').slice(0, diagnostic.pos)
			const lastNewline = prefix.lastIndexOf('\n')
			const line = prefix.split('\n').length
			const column = lastNewline < 0 ? diagnostic.pos + 1 : diagnostic.pos - lastNewline
			location += `(${line},${column})`
		}
		location += ': '
	}

	let output = `${location}${category} TS${diagnostic.code}: ${messageText(diagnostic)}`
	for (const related of diagnostic.relatedInformation ?? []) {
		output += `\n  ${formatDiagnostic(related, cwd, configPath, tempPath)}`
	}
	return output
}

function formatApiErrors(diagnostics: Diagnostic[], cwd: string, configPath: string, tempPath: string): string {
	const output: string[] = []
	for (const diagnostic of diagnostics) {
		if (diagnostic.category === 1) output.push(formatDiagnostic(diagnostic, cwd, configPath, tempPath))
	}
	return output.join('\n')
}

// Keep the script's contract identical to tsc: diagnostics go to stderr and any
// reported error produces exit code 1. Without a config, direct CLI checking is
// the correct fallback because there is no configured Program to preserve.
async function main(): Promise<void> {
	const arg = process.argv[2]
	if (!arg) fail('usage: bun scripts/tsc-file.ts <file>')

	const filePath = resolve(process.cwd(), arg)
	if (!existsSync(filePath)) fail(`error: file not found: ${filePath}`)

	const configPath = findConfig(filePath)
	const projectDirectory = configPath ? dirname(configPath) : dirname(filePath)
	const typescript = findTypeScript(projectDirectory)
	let output = ''

	if (configPath) {
		const tempPath = makeConfig(configPath, filePath)
		try {
			if (typescript.apiPath) {
				try {
					const diagnostics = await runApi(typescript.apiPath, tempPath, filePath, projectDirectory)
					output = formatApiErrors(diagnostics, projectDirectory, configPath, tempPath)
				} catch {
					// The API is explicitly unstable. Preserve correct feedback if a
					// future TypeScript release changes it by falling back to its CLI.
					output = runConfiguredTsc(typescript.tscPath, tempPath, filePath, configPath, projectDirectory)
				}
			} else {
				output = runConfiguredTsc(typescript.tscPath, tempPath, filePath, configPath, projectDirectory)
			}
		} finally {
			try {
				unlinkSync(tempPath)
			} catch {}
		}
	} else {
		output = runTsc(typescript.tscPath, [filePath, '--noEmit', '--pretty', 'false'], projectDirectory).trim()
	}

	if (output) process.stderr.write(`${output}\n`)
	process.exit(output ? 1 : 0)
}

await main()
