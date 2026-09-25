// Enforces the layout and import-time rules from tasks/README.md.
import { expect, test } from 'bun:test'
import { Glob } from 'bun'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'

const srcDir = import.meta.dir

// Top-level directory under src that a path belongs to, or '' for files
// directly in src (main.ts, the composition root, may import anything).
function layer(path: string): string {
	let rel = path.slice(srcDir.length + 1)
	let slash = rel.indexOf('/')
	if (slash < 0) return ''
	return rel.slice(0, slash)
}

// Which layers each layer may import. Unlisted layers are unrestricted.
const allowed: Record<string, string[]> = {
	common: ['common'],
	host: ['host', 'common'],
	client: ['client', 'common'],
}

function violation(file: string, target: string): string | undefined {
	let from = layer(file)
	let rules = allowed[from]
	if (!rules) return undefined
	let to = layer(target)
	if (rules.includes(to)) return undefined
	return `${file.slice(srcDir.length + 1)} imports ${target.slice(srcDir.length + 1) || target}`
}

function sourceFiles(): string[] {
	let files: string[] = []
	for (let rel of new Glob('**/*.ts').scanSync(srcDir)) {
		if (rel.endsWith('.test.ts')) continue
		files.push(`${srcDir}/${rel}`)
	}
	return files
}

function importsOf(file: string): string[] {
	let transpiler = new Bun.Transpiler({ loader: 'ts' })
	let code = readFileSync(file, 'utf8')
	let out: string[] = []
	for (let imp of transpiler.scanImports(code)) {
		// Only relative imports cross layers; packages and bun: builtins
		// are checked by eye (common must stay browser-safe).
		if (!imp.path.startsWith('.')) continue
		out.push(resolve(dirname(file), imp.path))
	}
	return out
}

test('layer rules reject cross-layer imports', () => {
	let s = srcDir
	expect(violation(`${s}/common/a.ts`, `${s}/host/b.ts`)).toBeDefined()
	expect(violation(`${s}/common/a.ts`, `${s}/client/b.ts`)).toBeDefined()
	expect(violation(`${s}/common/a.ts`, `${s}/main.ts`)).toBeDefined()
	expect(violation(`${s}/host/a.ts`, `${s}/client/b.ts`)).toBeDefined()
	expect(violation(`${s}/client/a.ts`, `${s}/host/x/b.ts`)).toBeDefined()
	expect(violation(`${s}/host/a.ts`, `${s}/common/b.ts`)).toBeUndefined()
	expect(violation(`${s}/client/a/b.ts`, `${s}/client/c.ts`)).toBeUndefined()
	expect(violation(`${s}/main.ts`, `${s}/host/b.ts`)).toBeUndefined()
})

test('source files respect layer boundaries', () => {
	let problems: string[] = []
	for (let file of sourceFiles()) {
		for (let target of importsOf(file)) {
			let v = violation(file, target)
			if (v) problems.push(v)
		}
	}
	expect(problems).toEqual([])
})

test('src has only common, host and client directories', () => {
	let dirs = new Set<string>()
	for (let file of sourceFiles()) {
		let l = layer(file)
		if (l) dirs.add(l)
	}
	for (let d of dirs) expect(Object.keys(allowed)).toContain(d)
})

// Importing every module, including main.ts, must not print, register
// signal handlers, or leave timers/watchers that keep the process alive.
test('importing every module has no side effects', () => {
	let imports = sourceFiles().map((f) => `await import(${JSON.stringify(f)})`)
	let script = [
		...imports,
		`let signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGTSTP', 'SIGCONT', 'SIGWINCH']`,
		`let n = signals.reduce((sum, s) => sum + process.listenerCount(s), 0)`,
		`process.stderr.write('signal-listeners=' + n)`,
	].join('\n')
	let out = Bun.spawnSync(['bun', '-e', script], { timeout: 5000 })
	expect(out.stdout.toString()).toBe('')
	expect(out.stderr.toString()).toBe('signal-listeners=0')
	expect(out.exitCode).toBe(0)
})
