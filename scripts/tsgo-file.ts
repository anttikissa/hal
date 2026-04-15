#!/usr/bin/env bun
// Type-check one file by creating a tiny child tsconfig that extends the real
// project config and narrows the root file set to a single target.
//
// We intentionally use `extends` instead of copying compiler options out of
// tsconfig.json. That lets TypeScript resolve the project exactly the same way
// as a normal full-project check, while still letting us override `files`.

import { existsSync, unlinkSync, writeFileSync } from 'fs'
import { relative, resolve } from 'path'

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

function main(): void {
	const arg = process.argv[2]
	if (!arg) fail('usage: bun scripts/tsgo-file.ts <file>')

	const root = resolve(import.meta.dir, '..')
	const filePath = resolve(process.cwd(), arg)
	if (!existsSync(filePath)) fail(`error: file not found: ${filePath}`)

	const config = {
		extends: './tsconfig.json',
		// Keep the full project config, but make tsgo treat this file as the only
		// root input. `types: ["bun"]` makes the Bun ambient globals explicit.
		compilerOptions: {
			types: ['bun'],
		},
		include: [],
		files: [relative(root, filePath)],
	}

	// The temp config must live under the repo root because TypeScript resolves
	// relative `extends` and `files` entries from the config file location.
	const tempPath = resolve(root, `.tsgo-file-${process.pid}-${Date.now()}.json`)
	writeFileSync(tempPath, JSON.stringify(config, null, 2))

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
