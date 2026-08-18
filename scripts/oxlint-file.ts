import { existsSync, readFileSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { ason } from '../src/utils/ason.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')
const FALLBACK_OXLINT = join(REPO_ROOT, 'node_modules/.bin/oxlint')
const CONFIG_NAMES = ['.oxlintrc.json', '.oxlintrc.jsonc', 'oxlint.config.ts', 'oxlint.config.mts']

function findConfig(filePath: string): string | null {
	let directory = dirname(filePath)
	while (true) {
		for (const name of CONFIG_NAMES) {
			const configPath = join(directory, name)
			if (existsSync(configPath)) return configPath
		}
		const parent = dirname(directory)
		if (parent === directory) return null
		directory = parent
	}
}

function findOxlint(configDirectory: string): string {
	let directory = configDirectory
	while (true) {
		const packagePath = join(directory, 'node_modules', 'oxlint', 'package.json')
		if (existsSync(packagePath)) {
			const packageJson = ason.parse(readFileSync(packagePath, 'utf-8')) as any
			const bin = packageJson.bin
			if (typeof bin === 'string') return resolve(dirname(packagePath), bin)
			if (typeof bin?.oxlint === 'string') return resolve(dirname(packagePath), bin.oxlint)
		}
		const parent = dirname(directory)
		if (parent === directory) return FALLBACK_OXLINT
		directory = parent
	}
}

function main(): void {
	const arg = process.argv[2]
	if (!arg) {
		console.error('Usage: bun scripts/oxlint-file.ts <file>')
		process.exit(1)
	}

	const filePath = resolve(process.cwd(), arg)
	const configPath = findConfig(filePath)
	if (!configPath) return

	const configDirectory = dirname(configPath)
	const proc = Bun.spawnSync([findOxlint(configDirectory), relative(configDirectory, filePath)], {
		cwd: configDirectory,
		stdin: 'ignore',
		stdout: 'inherit',
		stderr: 'inherit',
	})
	process.exit(proc.exitCode ?? 1)
}

main()
