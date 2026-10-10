import { readdir, stat } from 'fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'path'
import { fileChanges } from './file-changes.ts'

function excluded(path: string): boolean {
	return path.split('/').some((part) => part === '.git' || fileTracking.generatedDirs.includes(part))
}

function inside(path: string, root: string): boolean {
	let name = relative(root, path)
	return name !== '..' && !name.startsWith('../') && !isAbsolute(name)
}

async function repo(cwd: string): Promise<string | undefined> {
	try { await stat(cwd) } catch (e: any) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return; throw e }
	let result = await fileChanges.git(cwd, ['rev-parse', '--show-toplevel'])
	if (!result.code) return result.text.trimEnd()
	if (result.error.includes('not a git repository')) return
	throw new Error(result.error)
}

async function filter(cwd: string, names: string[], patterns = false): Promise<string[]> {
	let candidates: { name: string; paths: string[] }[] = []
	for (let name of names) {
		let absolute = resolve(cwd, name)
		if (fileTracking.excluded(absolute)) continue
		let canonical = await fileChanges.canonical(absolute)
		if (!fileTracking.excluded(canonical)) candidates.push({ name, paths: [...new Set([absolute, canonical])] })
	}
	if (!candidates.length) return []
	let root = await fileTracking.repo(cwd)
	if (!root) return candidates.map((c) => c.name)
	let paths = [...new Set(candidates.flatMap((c) => patterns && /[*?[\]{}]/.test(c.name) ? [] : c.paths.filter((p) => fileTracking.inside(p, root))))]
	let ignored = new Set<string>()
	for (let at = 0; at < paths.length; at += 1024) {
		let result = await fileChanges.git(root, ['check-ignore', '-z', '--stdin'], paths.slice(at, at + 1024).join('\0') + '\0')
		if (result.code > 1) throw new Error(result.error)
		for (let path of result.text.split('\0')) if (path) ignored.add(path)
	}
	return candidates.filter((c) => !c.paths.some((p) => ignored.has(p))).map((c) => c.name)
}

async function file(path: string): Promise<boolean> {
	try { return (await stat(path)).isFile() } catch (e: any) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false; throw e }
}

async function* walk(root: string): AsyncGenerator<string> {
	for (let entry of await readdir(root, { withFileTypes: true })) {
		let path = resolve(root, entry.name)
		if (fileTracking.excluded(path)) continue
		if (entry.isDirectory()) yield* fileTracking.walk(path)
		else if (entry.isFile() || entry.isSymbolicLink() && await fileTracking.file(path)) yield path
	}
}

async function glob(cwd: string, pattern: string): Promise<string[]> {
	let absolute = resolve(cwd, pattern)
	let parts = absolute.split('/')
	let first = parts.findIndex((part) => /[*?[\]{}]/.test(part))
	let root = first < 0 ? dirname(absolute) : parts.slice(0, first).join('/') || '/'
	if (fileTracking.excluded(root)) return []
	try { if (!(await stat(root)).isDirectory()) return [] } catch (e: any) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return []; throw e }
	let matcher = new Bun.Glob(absolute), found: string[] = []
	if (await fileTracking.repo(root)) {
		let result = await fileChanges.git(root, ['ls-files', '--cached', '--others', '--exclude-standard', ...fileTracking.generatedDirs.map((name) => `--exclude=${name}/`), '-z'])
		if (result.code) throw new Error(result.error)
		for (let name of result.text.split('\0')) {
			if (!name) continue
			let path = resolve(root, name)
			if (!fileTracking.excluded(path) && matcher.match(path) && await fileTracking.file(path)) found.push(isAbsolute(pattern) ? path : relative(cwd, path))
		}
	} else {
		for await (let path of fileTracking.walk(root)) if (matcher.match(path)) found.push(isAbsolute(pattern) ? path : relative(cwd, path))
	}
	return found
}

export const fileTracking = { generatedDirs: ['node_modules'], excluded, inside, repo, filter, file, walk, glob }
