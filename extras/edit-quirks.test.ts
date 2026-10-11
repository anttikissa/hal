import '../src/host/host.ts'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import multiedit from './multiedit.ts'
import quirks from './edit-quirks.ts'
import { plugins, type Loaded } from '../src/host/plugins.ts'
import { actions } from '../src/host/actions.ts'
import { diag } from '../src/host/diag.ts'
import { testHome, useHost } from '../src/host/host-fixture.test.ts'

useHost()
let entries: Loaded[] = []
beforeEach(() => {
	entries = [multiedit, quirks].map((load, i) => { const entry: Loaded = { path: `p${i}.ts`, hash: '', hooks: [], open: true }; load(plugins.api(entry)); delete entry.open; return entry })
})
afterEach(() => { for (const e of entries.reverse()) plugins.deactivate(e) })

const head = ['EDIT', 'a replace', '!!OLD', 'x', '!!NEW', 'y', '!!END']
const at = (model?: string) => (model ? { cwd: testHome(), sessionId: 's1', model } : undefined)
const resolve = (lines: string[], model?: string) => actions.resolve(lines.join('\n'), at(model)).input
const sonnet = 'anthropic/claude-sonnet-5-5'
const edits = [{ path: 'a', old: 'x', new: 'y' }]

test('each quirk rescues Sonnet; other models and unknown sessions get the strict error', () => {
	mkdirSync(dirname(diag.file()), { recursive: true })
	const cases: [string[], unknown][] = [
		[['$ npm test 2>&1 | tail -15', '$ echo "ok"'], { edits, then: ['BASH "npm test 2>&1 | tail -15"', 'BASH "echo \\"ok\\""'] }],
		[['<invoke name="Action">', '<parameter name="action">BASH "npm test"</parameter>', '</invoke>'], { edits, then: ['BASH "npm test"'] }],
		[['approve', 'BASH "npm test"'], { edits, then: ['BASH "npm test"'] }],
		[['That', '!!END'], { edits }],
		[['EDIT', '<br>', '!!END'], { edits }],
		[['READ'], { edits }],
		[['f.ts replace', '!!OLD', '!!NEW', '!!END'], { edits }],
		[['f.ts@ replace 1-1', '!!NEW', 'z', '!!END'], { edits: [...edits, { path: 'f.ts', range: '1-1', lines: ['z'] }] }],
	]
	for (const [tail, want] of cases) {
		expect(resolve([...head, ...tail], sonnet)).toEqual(want as any)
		for (const model of ['openai/gpt-6.1-sol', undefined]) {
			const strict = (() => { try { return resolve([...head, ...tail], model) } catch (e: any) { return e.message } })()
			expect(strict).not.toEqual(want)
		}
	}
	expect(() => resolve([...head, 'some prose here'], sonnet)).toThrow('EDIT line 8')
	expect(readFileSync(diag.file(), 'utf8')).toContain(`edit-quirks: shell fired for ${sonnet} in s1`)
})

test('call markup is a quirk for Opus too; other quirks are not', () => {
	expect(resolve([...head, '<invoke name="Action">', '<parameter name="action">BASH "ls"</parameter>'], 'anthropic/claude-opus-5-5')).toEqual({ edits, then: ['BASH "ls"'] })
	expect(() => resolve([...head, '$ ls'], 'anthropic/claude-opus-5-5')).toThrow('EDIT line 8')
})
