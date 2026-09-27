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
	web: ['web', 'common'],
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
	for (let rel of new Glob('**/*.{ts,tsx}').scanSync(srcDir)) {
		if (/\.test\.tsx?$/.test(rel)) continue
		files.push(`${srcDir}/${rel}`)
	}
	return files
}

function importsOf(file: string): string[] {
	let transpiler = new Bun.Transpiler({ loader: file.endsWith('.tsx') ? 'tsx' : 'ts' })
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
	expect(violation(`${s}/web/a.ts`, `${s}/host/b.ts`)).toBeDefined()
	expect(violation(`${s}/web/a.ts`, `${s}/client/b.ts`)).toBeDefined()
	expect(violation(`${s}/host/a.ts`, `${s}/web/b.ts`)).toBeDefined()
	expect(violation(`${s}/web/a.ts`, `${s}/common/b.ts`)).toBeUndefined()
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

test('src has only common, host, client and web directories', () => {
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

// Modules stay under maxLines so each fits one read and has one job.
// Exceptions carry a reason; a planned split names its task.
const maxLines = 400
const sizeExceptions: Record<string, string> = {
	'common/ason.ts': 'one cohesive format: parser and stringifier belong together',
	'host/host.ts': 'split planned in task yq',
	'client/frame.ts': 'split planned in task 3m',
	'web/page.ts': 'split planned in task 1b',
}

// Line count as wc -l reports it: the number of newlines.
function lineCount(text: string): number {
	let n = 0
	for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++
	return n
}

// sizes maps src-relative paths to line counts. Returns one message per
// oversized unlisted file and per listed file that is small or missing.
function sizeProblems(sizes: Record<string, number>, exceptions: Record<string, string>): string[] {
	let problems: string[] = []
	for (let [rel, n] of Object.entries(sizes)) {
		if (n > maxLines && !(rel in exceptions)) problems.push(`${rel} has ${n} lines (max ${maxLines})`)
	}
	for (let rel of Object.keys(exceptions)) {
		if (!(rel in sizes)) problems.push(`${rel} is listed as an exception but does not exist`)
		else if (sizes[rel]! <= maxLines) problems.push(`${rel} is listed as an exception but has only ${sizes[rel]} lines`)
	}
	return problems
}

test('lineCount matches wc -l', () => {
	expect(lineCount('')).toBe(0)
	expect(lineCount('a')).toBe(0)
	expect(lineCount('a\nb\n')).toBe(2)
})

test('size check flags oversized files and stale exceptions', () => {
	expect(sizeProblems({ 'a.ts': 400 }, {})).toEqual([])
	let over = sizeProblems({ 'a.ts': 401 }, {})
	expect(over).toHaveLength(1)
	expect(over[0]).toContain('a.ts')
	expect(over[0]).toContain('401')
	expect(sizeProblems({ 'a.ts': 401 }, { 'a.ts': 'reason' })).toEqual([])
	expect(sizeProblems({ 'a.ts': 400 }, { 'a.ts': 'reason' })).toHaveLength(1)
	expect(sizeProblems({}, { 'gone.ts': 'reason' })).toHaveLength(1)
})

test('source modules stay under the line limit', () => {
	let sizes: Record<string, number> = {}
	for (let file of sourceFiles()) sizes[file.slice(srcDir.length + 1)] = lineCount(readFileSync(file, 'utf8'))
	expect(sizeProblems(sizes, sizeExceptions)).toEqual([])
})
