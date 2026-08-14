import { expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { dirname, relative, resolve } from 'path'
import * as ts from 'typescript'

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
		const imports = ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles
		for (const item of imports) {
			const targetPath = importedPath(file, item.fileName)
			if (!targetPath) continue
			const targetLayer = layer(targetPath)
			if (!targetLayer || allowed(sourceLayer, targetLayer)) continue
			found.push(`${relative(root, file)} -> ${relative(root, targetPath)} (${sourceLayer} cannot import ${targetLayer})`)
		}
	}
	return found.sort()
}

test('source layers only import in allowed directions', () => {
	const found = violations()
	expect(found, found.join('\n')).toEqual([])
})
