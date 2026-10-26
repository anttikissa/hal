// Keeps project instructions and plugins behind one remembered trust decision.
// A session may override it: hal -p -d trusts its project, --no-trust none.
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'fs'
import { relative, resolve } from 'path'
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

// `own`: the session's override (SessionMeta.projectTrust).
function allowed(cwd: string, own?: string | false): boolean {
	let root = projectContext.root(cwd)
	return own !== false && (own === root || projectContext.file().projects[root] === true)
}

function decide(cwd: string, trust: boolean): void {
	mkdirSync(paths.stateDir(), { recursive: true })
	let data = projectContext.file()
	data.projects[projectContext.root(cwd)] = trust
	liveFiles.save(data)
}

// Forgets the decision, so Hal asks again.
function forget(cwd: string): void {
	let data = projectContext.file()
	delete data.projects[projectContext.root(cwd)]
	liveFiles.save(data)
}

// The project content Hal skips in `cwd`: none when trusted.
function skipped(cwd: string, own?: string | false): string[] {
	return projectContext.allowed(cwd, own) ? [] : projectContext.contents(cwd)
}

function names(dir: string): string[] {
	try {
		return readdirSync(dir)
	} catch (e: any) {
		if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return []
		throw e
	}
}

// What trust covers, outermost first: each directory's AGENTS.md or
// CLAUDE.md, project skills and native plugins.
function contents(cwd: string): string[] {
	return systemPrompt.candidates(cwd).flatMap((dir) => {
		let base = dir === '/' ? '' : dir
		let found = (sub: string, keep: (name: string) => boolean) =>
			names(`${base}/${sub}`)
				.filter(keep)
				.map((name) => `${base}/${sub}/${name}`)
		return [
			...['AGENTS.md', 'CLAUDE.md']
				.map((name) => `${base}/${name}`)
				.filter((p) => existsSync(p))
				.slice(0, 1),
			...['.agents/skills', '.claude/skills'].flatMap((sub) =>
				found(sub, (name) => existsSync(`${base}/${sub}/${name}/SKILL.md`)),
			),
			...found('.agents/plugins/hal', (name) => name.endsWith('.ts') && !name.endsWith('.d.ts')),
		]
	})
}

// Unattended sessions (hal -p) have nobody to answer, so they never ask.
// A tab that answered "Not now" is not asked again until its next /cd.
function question(cwd: string, id?: string): Form | undefined {
	if (id !== undefined && sessions.open(id).interactive === false) return
	let root = projectContext.root(cwd)
	if (id !== undefined && projectContext.state.later.get(id) === root) return
	if (Object.hasOwn(projectContext.file().projects, root) || !projectContext.contents(cwd).length) return
	return {
		text: 'Trust this project? Its instructions, skills, and plugins can direct Hal and run code with your permissions. You can change this later with /trust.',
		quote: { text: root },
		fields: [{ type: 'choice', name: 'project_trust', options: ['Trust', 'Not now', 'Never trust'], initial: 1 }],
		skip: true,
	}
}

function answer(id: string, form: Form, answers: Answers): boolean {
	if (form.fields[0]?.name !== 'project_trust' || !form.quote) return false
	if (projectContext.root(form.quote.text) !== form.quote.text)
		throw new Error(`Project root changed since the trust question: ${form.quote.text}`)
	if ((answers.project_trust ?? 'Not now') === 'Not now') projectContext.state.later.set(id, form.quote.text)
	else projectContext.decide(form.quote.text, answers.project_trust === 'Trust')
	return true
}

// What a hal -p run tells stderr: the project files it reads or skips,
// and why. `trust` is the run's override: -d (true) or --no-trust.
function report(id: string, trust?: boolean): string | undefined {
	let cwd = sessions.open(id).cwd
	let base = systemPrompt.candidates(cwd)[0]!
	let files = projectContext.contents(cwd).map((path) => relative(base, path))
	if (!files.length) return
	let root = projectContext.root(cwd),
		list = files.join(', ')
	if (trust === false) return `--no-trust, skipping ${root}: ${list}`
	if (trust) return `-d given, trusting ${root}: ${list}`
	return projectContext.allowed(cwd)
		? `trusted ${root}: reading ${list}`
		: `${root} is not trusted; skipping ${list} (pass -d to trust it)`
}

async function refresh(): Promise<void> {
	let wanted = new Set<string>()
	for (let id of tabs.file().open) {
		let meta
		try {
			meta = sessions.open(id)
		} catch (e: any) {
			plugins.report(`project plugins for ${id}: ${e?.stack ?? e}`)
			continue
		}
		let cwd = meta.cwd
		if (!projectContext.allowed(cwd, meta.projectTrust)) continue
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
	projectContext.state.later.clear()
}

export const projectContext = {
	state: {
		file: undefined as Decisions | undefined,
		active: new Set<string>(),
		// Session id → project root the tab answered "Not now" for.
		later: new Map<string, string>(),
	},
	file,
	root,
	allowed,
	decide,
	forget,
	skipped,
	contents,
	question,
	answer,
	report,
	refresh,
	ready,
	changed,
	reset,
}
