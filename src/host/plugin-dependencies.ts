// Watches plugin-owned imports; core modules keep their shared identity.
import { readFileSync, realpathSync, watch, type FSWatcher } from 'fs'
import { dirname, extname, resolve, sep } from 'path'

type Graph = Map<string, { hash: ReturnType<typeof Bun.hash>; imports: string[] }>
const core = resolve(import.meta.dir, '..') + sep
const graphs = new Map<string, Graph>()
const watchers = new Map<string, FSWatcher>()
let queue = Promise.resolve()
let generation = 0
let reload: (path: string) => Promise<void>
let report: (text: string) => void
let rootDir = ''

function scan(path: string, graph: Graph): void {
	if (graph.has(path)) return
	let source = readFileSync(path), imports: string[] = []
	graph.set(path, { hash: Bun.hash(source), imports })
	if (extname(path) === '.json') return
	const loader = /\.[jt]sx$/.test(path) ? 'tsx' : 'ts'
	for (let item of new Bun.Transpiler({ loader }).scanImports(source.toString())) {
		if (!item.path.startsWith('.') && !item.path.startsWith('/')) continue
		let file = realpathSync(Bun.resolveSync(item.path, dirname(path)))
		if (file.startsWith(core) || file.includes(`${sep}node_modules${sep}`)) continue
		if (!/\.(?:[cm]?[jt]sx?|json)$/.test(file)) continue
		imports.push(file)
		scan(file, graph)
	}
}

function reconcile(): void {
	let dirs = new Set([...graphs.values()].flatMap(g => [...g.keys()].map(dirname)))
	dirs.delete(rootDir)
	for (let [dir, watcher] of watchers) if (!dirs.has(dir)) { watcher.close(); watchers.delete(dir) }
	for (let dir of dirs) if (!watchers.has(dir)) {
		let watcher = watch(dir, { persistent: false }, (_event, name) => { if (name) changed(resolve(dir, name)) })
		watcher.on('error', error => report(`plugin dependency watch ${dir}: ${error.stack ?? error}`))
		watchers.set(dir, watcher)
	}
}

function changed(path: string, sync?: () => Promise<void>): Promise<void> {
	let gen = generation
	queue = queue.then(async () => {
		if (gen !== generation) return
		if (![...graphs.values()].some(graph => graph.has(path))) { await sync?.(); return }
		let hash: ReturnType<typeof Bun.hash> | undefined
		try { hash = Bun.hash(readFileSync(path)) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
		let affected: string[] = [], invalid = new Set<string>()
		for (let [root, graph] of graphs) {
			if (!graph.has(path) || graph.get(path)!.hash === hash) continue
			let dirty = new Set([path])
			for (let size = -1; size !== dirty.size;) {
				size = dirty.size
				for (let [file, node] of graph) if (node.imports.some(i => dirty.has(i))) dirty.add(file)
			}
			for (let file of dirty) invalid.add(file)
			affected.push(root)
		}
		for (let file of invalid) delete require.cache[file]
		for (let root of affected) if (gen === generation) await reload(root)
		if (gen === generation) await sync?.()
	}).catch(error => report(`plugin dependency ${path}: ${error.stack ?? error}`))
	return queue
}

export const pluginDependencies = {
	init(dir: string, load: typeof reload, error: typeof report) { rootDir = realpathSync(dir); reload = load; report = error; reconcile() },
	track(root: string) {
		let graph: Graph = new Map()
		scan(realpathSync(root), graph)
		graphs.set(root, graph)
		if (rootDir) reconcile()
	},
	remove(root: string) { graphs.delete(root); if (rootDir) reconcile() },
	changed,
	close() {
		generation++
		for (let watcher of watchers.values()) watcher.close()
		watchers.clear(); graphs.clear(); rootDir = ''
	},
}
