// Keeps project instructions and plugins behind one remembered trust decision.
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'fs'
import { resolve } from 'path'
import type { Answers, Form } from '../common/forms.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { plugins } from './plugins.ts'
import { sessions } from './sessions.ts'
import { systemPrompt } from './system-prompt.ts'
import { tabs } from './tabs.ts'

type Decisions = { projects: Record<string, boolean> }

function file(): Decisions {
	if (!projectContext.state.file) {
		let path = `${paths.stateDir()}/project-trust.ason`
		let data = liveFiles.liveFile<Decisions>(path, { projects: {} }, { watch: false })
		if (
			!data.projects ||
			Array.isArray(data.projects) ||
			typeof data.projects !== 'object' ||
			Object.values(data.projects).some((value) => typeof value !== 'boolean')
		) {
			liveFiles.close(data)
			throw new Error(`${path}: projects must map project roots to booleans`)
		}
		projectContext.state.file = data
	}
	return projectContext.state.file
}

function root(cwd: string): string {
	let path = systemPrompt.candidates(cwd)[0]!
	try {
		return realpathSync(path)
	} catch {
		return resolve(path)
	}
}

function allowed(cwd: string): boolean {
	return projectContext.file().projects[projectContext.root(cwd)] === true
}

function decide(cwd: string, trust: boolean): void {
	mkdirSync(paths.stateDir(), { recursive: true })
	let data = projectContext.file()
	data.projects[projectContext.root(cwd)] = trust
	liveFiles.save(data)
}

function names(dir: string): string[] {
	try {
		return readdirSync(dir)
	} catch (e: any) {
		if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return []
		throw e
	}
}

function relevant(cwd: string): boolean {
	return systemPrompt
		.candidates(cwd)
		.some(
			(dir) =>
				['AGENTS.md', 'CLAUDE.md'].some((name) => existsSync(`${dir}/${name}`)) ||
				['.agents/skills', '.claude/skills'].some((sub) =>
					names(`${dir}/${sub}`).some((name) => existsSync(`${dir}/${sub}/${name}/SKILL.md`)),
				) ||
				names(`${dir}/.agents/plugins/hal`).some((name) => name.endsWith('.ts') && !name.endsWith('.d.ts')),
		)
}

function question(cwd: string): Form | undefined {
	let root = projectContext.root(cwd)
	if (Object.hasOwn(projectContext.file().projects, root) || !projectContext.relevant(cwd)) return
	return {
		text: 'Trust this project? Its instructions, skills, and plugins can direct Hal and run code with your permissions. This includes future changes.',
		quote: { text: root },
		fields: [
			{
				type: 'choice',
				name: 'project_trust',
				options: ['Trust project', 'Continue without project content'],
				initial: 1,
			},
		],
	}
}

function answer(form: Form, answers: Answers): boolean {
	if (form.fields[0]?.name !== 'project_trust' || !form.quote) return false
	if (projectContext.root(form.quote.text) !== form.quote.text)
		throw new Error(`Project root changed since the trust question: ${form.quote.text}`)
	projectContext.decide(form.quote.text, answers.project_trust === 'Trust project')
	return true
}

async function refresh(): Promise<void> {
	let wanted = new Set<string>()
	let cwds = new Set<string>()
	for (let id of tabs.file().open) {
		try {
			cwds.add(sessions.open(id).cwd)
		} catch (e: any) {
			plugins.report(`project plugins for ${id}: ${e?.stack ?? e}`)
		}
	}
	for (let cwd of cwds) {
		if (!projectContext.allowed(cwd)) continue
		for (let dir of systemPrompt.candidates(cwd)) {
			let path = `${dir}/.agents/plugins/hal`
			if (existsSync(path)) {
				let canonical = realpathSync(path)
				if (!plugins.state.personalDirectories.has(canonical)) wanted.add(canonical)
			}
		}
	}
	let old = projectContext.state.active
	projectContext.state.active = wanted
	for (let dir of old) if (!wanted.has(dir)) plugins.deactivateDirectory(dir)
	await projectContext.ready()
}

async function ready(): Promise<void> {
	await Promise.all([...projectContext.state.active].map((dir) => plugins.activateDirectory(dir)))
}

function changed(): void {
	void projectContext.refresh().catch((e) => plugins.report(`project plugins: ${e?.stack ?? e}`))
}

function reset(): void {
	for (let dir of projectContext.state.active) plugins.deactivateDirectory(dir)
	projectContext.state.active.clear()
	if (projectContext.state.file) liveFiles.close(projectContext.state.file)
	projectContext.state.file = undefined
}

export const projectContext = {
	state: { file: undefined as Decisions | undefined, active: new Set<string>() },
	file,
	root,
	allowed,
	decide,
	relevant,
	question,
	answer,
	refresh,
	ready,
	changed,
	reset,
}
