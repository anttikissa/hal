import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { nativeTool } from '../native-tool.ts'
import { tool } from './grep.ts'

let dir = ''
let rg = tool.rg
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'hal-grep-'))
	mkdirSync(join(dir, 'src'))
	writeFileSync(join(dir, 'src/a.ts'), 'let x = 1\nfunction resolve(path) {\n\treturn status(path)\n}\n')
	writeFileSync(join(dir, 'src/b.js'), 'status(ok)\nnothing here\n')
	writeFileSync(join(dir, 'README.md'), 'resolve( is mentioned\n')
	writeFileSync(join(dir, '.gitignore'), 'ignored.ts\n')
	writeFileSync(join(dir, 'ignored.ts'), 'resolve(\n')
	Bun.spawnSync(['git', 'init', '-q'], { cwd: dir })
})
afterAll(() => {
	tool.rg = rg
	rmSync(dir, { recursive: true, force: true })
})

let run = (input: Record<string, unknown>) => tool.run(input, { cwd: dir, sessionId: 's', signal: new AbortController().signal })
let engines = [['rg', rg], ['built-in', () => undefined]] as const

for (let [name, engine] of engines) {
	test(`${name}: a valid regex searches non-ignored files, grouped by path`, async () => {
		if (name === 'rg' && !rg()) return
		tool.rg = engine
		expect(await run({ pattern: 'resolve\\(|status\\(ok' })).toBe('README.md:1: resolve( is mentioned\nsrc/a.ts:2: function resolve(path) {\nsrc/b.js:1: status(ok)')
	})

	test(`${name}: an invalid regex is searched as literal alternatives`, async () => {
		if (name === 'rg' && !rg()) return
		tool.rg = engine
		let out = await run({ pattern: 'status(|resolve(', in: 'src', glob: '*.ts' })
		expect(out).toBe('Invalid regex, so searched as literal text: "status(" or "resolve("\nsrc/a.ts:2: function resolve(path) {\nsrc/a.ts:3: \treturn status(path)')
	})

	test(`${name}: missing paths are named, the rest searched; context and files modes`, async () => {
		if (name === 'rg' && !rg()) return
		tool.rg = engine
		expect(await run({ pattern: 'nothing', in: ['nope', 'src'], context: 1 })).toBe('No such path: nope\nsrc/b.js-1- status(ok)\nsrc/b.js:2: nothing here')
		expect(await run({ pattern: 'status', files: true })).toBe('src/a.ts\nsrc/b.js')
	})
}

test('only missing paths is an error; GREP call text resolves paths and options', async () => {
	expect(await tool.run({ pattern: 'x', in: 'nope' }, { cwd: dir, sessionId: 's', signal: new AbortController().signal })).toEqual({ text: 'No such path: nope', isError: true })
	expect(nativeTool.resolve('GREP "a|b" "src" { glob: "*.ts" }')).toEqual({ name: 'grep', input: { pattern: 'a|b', glob: '*.ts', in: ['src'] } })
})
