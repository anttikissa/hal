import { expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { dirname, relative, resolve } from 'path'

// TypeScript 7's npm package is the native compiler and ships no JS parser API,
// so imports are scanned with Bun's transpiler instead of ts.preProcessFile.
const transpiler = new Bun.Transpiler({ loader: 'tsx' })

type Layer = 'common' | 'server' | 'client' | 'web-client'

const root = resolve(import.meta.dir, '..')
const sourceRoot = resolve(root, 'src')

function sourceFiles(dir: string): string[] {
	const files: string[] = []
	for (const name of readdirSync(dir).sort()) {
		const path = resolve(dir, name)
		if (statSync(path).isDirectory()) files.push(...sourceFiles(path))
		else if (/\.[jt]sx?$/.test(name)) files.push(path)
	}
	return files
}

function layer(path: string): Layer | null {
	const sourcePath = relative(sourceRoot, path).replaceAll('\\', '/')
	if (sourcePath.startsWith('common/')) return 'common'
	if (sourcePath.startsWith('server/')) return 'server'
	if (sourcePath.startsWith('client/')) return 'client'
	if (sourcePath.startsWith('web-client/')) return 'web-client'
	return null
}

function clientArea(path: string): 'app' | 'terminal' | null {
	const sourcePath = relative(sourceRoot, path).replaceAll('\\', '/')
	if (sourcePath.startsWith('client/terminal/')) return 'terminal'
	if (sourcePath.startsWith('client/')) return 'app'
	return null
}

// Module specifiers a file imports. Type-only imports are erased by the
// transpiler and so aren't caught here, but that's fine — this check only
// needs to catch real runtime coupling between layers, not type leakage.
function scanImports(source: string): string[] {
	return transpiler.scanImports(source).map((item) => item.path)
}

function importedPath(file: string, specifier: string): string | null {
	let path: string
	if (specifier.startsWith('.')) path = resolve(dirname(file), specifier)
	else if (specifier.startsWith('~/')) path = resolve(root, specifier.slice(2))
	else return null
	if (existsSync(path)) return path
	if (existsSync(`${path}.ts`)) return `${path}.ts`
	if (existsSync(resolve(path, 'index.ts'))) return resolve(path, 'index.ts')
	return null
}

function allowed(source: Layer, target: Layer): boolean {
	if (source === target) return true
	return target === 'common' && source !== 'common'
}

function violations(): string[] {
	const found: string[] = []
	for (const file of sourceFiles(sourceRoot)) {
		const sourceLayer = layer(file)
		if (!sourceLayer) continue
		for (const specifier of scanImports(readFileSync(file, 'utf8'))) {
			const targetPath = importedPath(file, specifier)
			if (!targetPath) continue
			const targetLayer = layer(targetPath)
			if (!targetLayer) continue
			if (sourceLayer === 'client' && targetLayer === 'client' && clientArea(file) === 'app' && clientArea(targetPath) === 'terminal') {
				found.push(`${relative(root, file)} -> ${relative(root, targetPath)} (client app cannot import terminal implementation)`)
				continue
			}
			if (allowed(sourceLayer, targetLayer)) continue
			found.push(`${relative(root, file)} -> ${relative(root, targetPath)} (${sourceLayer} cannot import ${targetLayer})`)
		}
	}
	return found.sort()
}

function terminalLeaks(): string[] {
	const found: string[] = []
	for (const file of sourceFiles(resolve(sourceRoot, 'client'))) {
		if (clientArea(file) !== 'app' || file.endsWith('.test.ts')) continue
		const text = readFileSync(file, 'utf8')
		if (/\\x1b|process\.(?:stdin|stdout)/.test(text)) found.push(relative(root, file))
	}
	return found
}

test('source layers only import in allowed directions', () => {
	const found = violations()
	expect(found, found.join('\n')).toEqual([])
})


test('terminal escape and stdio access stay in client/terminal', () => {
	const found = terminalLeaks()
	expect(found, found.join('\n')).toEqual([])
})
