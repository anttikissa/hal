import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { client, created, testHome, useHost } from './host-fixture.test.ts'
import { promptFiles } from './prompt-files.ts'
import { systemPrompt } from './system-prompt.ts'

useHost()

test('AGENTS.md changes reach only tabs they apply to; SYSTEM.md changes reach all', () => {
	let root = `${testHome()}/proj`, other = `${testHome()}/other`
	mkdirSync(`${root}/.git`, { recursive: true }); mkdirSync(`${root}/sub`); mkdirSync(other)
	let system = `${testHome()}/SYSTEM.md`
	writeFileSync(system, 'v1'); writeFileSync(`${root}/AGENTS.md`, 'v1')
	let file = systemPrompt.file
	systemPrompt.file = () => system
	try {
		let a = client(), b = client()
		let inProj = created(a, `${root}/sub`), elsewhere = created(b, other)
		let got = { a: [] as any[], b: [] as any[] }
		let watchers = [{ visible: inProj, deliver: (e: any) => got.a.push(e) }, { visible: elsewhere, deliver: (e: any) => got.b.push(e) }]
		promptFiles.check(watchers) // first sight: remembered, nothing shown
		expect(got).toEqual({ a: [], b: [] })

		writeFileSync(`${root}/AGENTS.md`, 'v2')
		writeFileSync(`${root}/sub/CLAUDE.md`, 'new')
		writeFileSync(`${other}/../AGENTS.md`, 'outside every project')
		promptFiles.check(watchers)
		expect(got.a.map((e) => [e.name, e.what])).toEqual([['AGENTS.md', 'changed'], ['CLAUDE.md', 'created']])
		expect(got.b).toEqual([])

		writeFileSync(system, 'v2'); rmSync(`${root}/AGENTS.md`)
		promptFiles.check(watchers)
		expect(got.a.slice(2).map((e) => [e.name, e.what])).toEqual([['SYSTEM.md', 'changed'], ['AGENTS.md', 'deleted']])
		expect(got.b.map((e) => [e.name, e.what, e.session])).toEqual([['SYSTEM.md', 'changed', elsewhere]])
	} finally {
		systemPrompt.file = file
	}
})
