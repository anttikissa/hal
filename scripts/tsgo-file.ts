#!/usr/bin/env bun
// Type-check one file by cloning the repo tsconfig and overriding its entry set.
//
// We do not mutate the real tsconfig.json. Instead we parse it as JSONC/ASON,
// inject a single-file `files` list, then point tsgo at a temporary config.
// That keeps all normal compiler options intact while narrowing the check.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { relative, resolve } from 'path'
import { tmpdir } from 'os'
import { ason } from '../src/utils/ason.ts'

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

function main(): void {
	const arg = process.argv[2]
	if (!arg) fail('usage: bun scripts/tsgo-file.ts <file>')

	const root = resolve(import.meta.dir, '..')
	const tsconfigPath = resolve(root, 'tsconfig.json')
	const filePath = resolve(process.cwd(), arg)
	if (!existsSync(filePath)) fail(`error: file not found: ${filePath}`)

	const raw = readFileSync(tsconfigPath, 'utf-8')
	const parsed = ason.parse(raw, { comments: true })
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		fail(`error: ${tsconfigPath} did not parse to an object`)
	}

	// Clone the top-level config so we keep the real project options, but make
	// tsgo treat the requested file as the only root input.
	const config = { ...(parsed as Record<string, unknown>) }
	config.include = []
	config.files = [relative(root, filePath)]

	const tempPath = resolve(tmpdir(), `hal-tsgo-file-${process.pid}-${Date.now()}.json`)
	writeFileSync(tempPath, JSON.stringify(config, null, 2))

	// Run tsgo from the repo root so any relative paths inside tsconfig keep the
	// same meaning they have during normal `./test` runs.
	const proc = Bun.spawnSync(['bunx', '--bun', 'tsgo', '-p', tempPath, '--noEmit'], {
		cwd: root,
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit',
	})

	try {
		unlinkSync(tempPath)
	} catch {}

	process.exit(proc.exitCode ?? 1)
}

main()
