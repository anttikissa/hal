// Project trust gates executable context; shared directories unload only after the last tab leaves.
import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { calls, client, created, testHome, until, useHost } from './host-fixture.test.ts'
import { projectContext } from './project-context.ts'
import { plugins } from './plugins.ts'
import { tabs } from './tabs.ts'
import { sessions } from './sessions.ts'
import { slash } from './slash.ts'
import { systemPrompt } from './system-prompt.ts'
import { promptFiles } from './prompt-files.ts'
import { forms } from '../common/forms.ts'
import { history } from './history.ts'

useHost()

function project(): string {
	let root = `${testHome()}/project`
	mkdirSync(`${root}/.git`, { recursive: true })
	mkdirSync(`${root}/sub`)
	mkdirSync(`${root}/.agents/plugins/hal`, { recursive: true })
	writeFileSync(`${root}/AGENTS.md`, 'PROJECT INSTRUCTION')
	writeFileSync(
		`${root}/.agents/plugins/hal/test.ts`,
		`export default () => {
  globalThis.projectStarts = (globalThis.projectStarts ?? 0) + 1;
  return () => globalThis.projectStops = (globalThis.projectStops ?? 0) + 1;
}`,
	)
	;(globalThis as any).projectStarts = 0
	;(globalThis as any).projectStops = 0
	return root
}

function tab(c: ReturnType<typeof client>, cwd: string): string {
	let id = created(c, cwd)
	tabs.insert(id, tabs.file().open.length)
	return id
}

test('a durable trust answer gates instructions and plugins; two tabs share one activation and last departure unloads', async () => {
	let root = project(),
		c = client(),
		a = tab(c, root),
		b = tab(c, `${root}/sub`)
	await projectContext.refresh()
	expect((globalThis as any).projectStarts).toBe(0)
	expect(systemPrompt.agents(root)).not.toContain('PROJECT INSTRUCTION')
	expect([...promptFiles.files(a)]).not.toContain(`${root}/AGENTS.md`)
	c.conn.send({ type: 'submit', sessionId: a, text: 'hello' })
	await until(() => c.of('question').length === 1)
	expect(calls).toHaveLength(0)
	let q = c.of('question')[0]!
	projectContext.reset()
	expect(forms.open(history.readSync(a))?.id).toBe(q.id)
	c.conn.send({ type: 'answer', sessionId: a, question: q.id, answers: { project_trust: 'Trust' } })
	await until(() => calls.length === 1)
	expect(calls[0]!.input.system).toContain('PROJECT INSTRUCTION')
	expect((globalThis as any).projectStarts).toBe(1)
	calls[0]!.push({ type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length === 1)
	slash.change(a, { cwd: testHome() })
	await projectContext.refresh()
	expect((globalThis as any).projectStops).toBe(0)
	expect(tabs.close(b)).toBeUndefined()
	await projectContext.refresh()
	expect((globalThis as any).projectStops).toBe(1)
	expect(plugins.state.files.has(`${root}/.agents/plugins/hal/test.ts`)).toBe(false)
	tabs.resume(b)
	await projectContext.refresh()
	expect((globalThis as any).projectStarts).toBe(2)
	expect(projectContext.question(root)).toBeUndefined()
	projectContext.reset()
	expect(projectContext.allowed(root)).toBe(true)
	await projectContext.refresh()
	expect((globalThis as any).projectStarts).toBe(3)
})

test('closing a tab rooted at the personal directory keeps personal plugins loaded', async () => {
	let root = project()
	await plugins.init(`${testHome()}/plugins`, `${root}/.agents/plugins/hal`)
	try {
		projectContext.decide(root, true)
		let id = tab(client(), root)
		await projectContext.refresh()
		expect((globalThis as any).projectStarts).toBe(1)
		tabs.close(id)
		await projectContext.refresh()
		projectContext.reset()
		expect((globalThis as any).projectStops).toBe(0)
		expect(plugins.state.files.has(`${root}/.agents/plugins/hal/test.ts`)).toBe(true)
	} finally {
		plugins.close()
	}
})

test('an unreadable open tab does not block another project activation', async () => {
	let root = project()
	projectContext.decide(root, true)
	tab(client(), root)
	tabs.file().open.push('999-missing')
	await projectContext.refresh()
	expect((globalThis as any).projectStarts).toBe(1)
	expect(tabs.list().find((tab) => tab.id === '999-missing')?.state.type).toBe('error')
})

test('/cd asks before changing cwd; Not now asks again on the next /cd, Never trust is remembered and changeable with /trust', async () => {
	let root = project(),
		c = client(),
		id = tab(c, testHome())
	let cd = async (dir: string, answer?: string) => {
		let asked = c.of('question').length
		c.conn.send({ type: 'submit', sessionId: id, text: `/cd ${dir}` })
		if (!answer) return until(() => sessions.open(id).cwd === dir)
		await until(() => c.of('question').length === asked + 1)
		expect(sessions.open(id).cwd).not.toBe(dir)
		let q = c.of('question').at(-1)!
		c.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { project_trust: answer } })
		await until(() => sessions.open(id).cwd === dir)
	}
	await cd(root, 'Not now')
	expect(Object.hasOwn(projectContext.file().projects, root)).toBe(false)
	expect(projectContext.question(root, id)).toBeUndefined()
	await cd(testHome())
	await cd(root, 'Never trust')
	c.conn.send({ type: 'submit', sessionId: id, text: 'hello' })
	await until(() => calls.length === 1)
	expect(calls[0]!.input.system).not.toContain('PROJECT INSTRUCTION')
	expect((globalThis as any).projectStarts).toBe(0)
	expect(projectContext.question(root)).toBeUndefined()
	expect(tabs.list().find((t) => t.id === id)?.untrusted).toBe(true)
	c.conn.send({ type: 'submit', sessionId: id, text: '/trust yes' })
	await until(() => (globalThis as any).projectStarts === 1)
	expect(tabs.list().find((t) => t.id === id)?.untrusted).toBeUndefined()
	c.conn.send({ type: 'submit', sessionId: id, text: '/trust forget' })
	await until(() => !Object.hasOwn(projectContext.file().projects, root))
	expect(projectContext.question(root)?.quote?.text).toBe(root)
})

test('empty projects ask nothing; new instructions, skills, or plugins ask, but trusted future changes do not', () => {
	for (let file of ['AGENTS.md', '.agents/skills/demo/SKILL.md', '.agents/plugins/hal/demo.ts']) {
		let root = `${testHome()}/${file.split('/').at(-1)}`
		mkdirSync(`${root}/.git`, { recursive: true })
		expect(projectContext.question(root)).toBeUndefined()
		mkdirSync(`${root}/${file.slice(0, file.lastIndexOf('/') + 1)}`, { recursive: true })
		writeFileSync(`${root}/${file}`, '')
		expect(projectContext.question(root)?.quote?.text).toBe(root)
		projectContext.decide(root, true)
		writeFileSync(`${root}/${file}`, 'changed')
		expect(projectContext.question(root)).toBeUndefined()
	}
})

test('trusted repo ancestors apply to nested cwd, not nested Git projects or unrelated non-Git children', () => {
	let root = project()
	projectContext.decide(root, true)
	expect(projectContext.allowed(`${root}/sub`)).toBe(true)
	mkdirSync(`${root}/sub/.git`)
	expect(projectContext.allowed(`${root}/sub`)).toBe(false)
	projectContext.decide(testHome(), true)
	mkdirSync(`${testHome()}/outside`)
	expect(projectContext.allowed(`${testHome()}/outside`)).toBe(false)
})

test('hal -p: -d trusts for its session only, --no-trust skips, and unattended tabs never ask', async () => {
	let root = project(),
		c = client(),
		n = 0
	let open = async (trust?: boolean) => {
		let id = `p${++n}`
		c.conn.send({ type: 'tab-new', cwd: `${root}/sub`, interactive: false, trust, id })
		await until(() => c.events.some((e: any) => e.type === 'ack' && e.id === id))
		let tab = (c.events.find((e: any) => e.type === 'ack' && e.id === id) as any).tab as string
		c.conn.send({ type: 'open', sessionId: tab })
		sessions.open(tab).model = 'fake/m1'
		return tab
	}
	let system = async (id: string) => {
		let before = calls.length
		c.conn.send({ type: 'submit', sessionId: id, text: 'hello' })
		await until(() => calls.length === before + 1)
		calls.at(-1)!.push({ type: 'done', reason: 'end' })
		return calls.at(-1)!.input.system as string
	}
	let warning = () => c.of('warning').at(-1)?.text
	let real = projectContext.root(root),
		files = 'AGENTS.md, .agents/plugins/hal/test.ts'
	expect(await system(await open(true))).toContain('PROJECT INSTRUCTION')
	expect(warning()).toBe(`-d given, trusting ${real}: ${files}`)
	expect(projectContext.file().projects).toEqual({})
	expect(await system(await open())).not.toContain('PROJECT INSTRUCTION')
	expect(warning()).toBe(`${real} is not trusted; skipping ${files} (pass -d to trust it)`)
	projectContext.decide(root, true)
	expect(await system(await open(false))).not.toContain('PROJECT INSTRUCTION')
	expect(warning()).toBe(`--no-trust, skipping ${real}: ${files}`)
	expect(c.of('question')).toHaveLength(0)
})
