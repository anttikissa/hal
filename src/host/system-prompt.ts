// Hookable prompt assembly from one input snapshot (tasks ar, q5g, ftg).

import { existsSync, readdirSync, realpathSync } from 'fs'
import { dirname, resolve } from 'path'
import { settings } from '../common/settings.ts'
import { clients } from './clients.ts'
import { nativeTool } from './native-tool.ts'
import { paths } from './paths.ts'
import { promptLang, type PromptRender, type PromptSource } from './prompt-lang.ts'
export type { PromptSource } from './prompt-lang.ts'
const systemFile = resolve(import.meta.dir, '../../SYSTEM.md')

function date(now: number, timeZone: string): string {
	let parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		weekday: 'long',
		timeZoneName: 'longOffset',
	}).formatToParts(now)
	let part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value
	return `${part('year')}-${part('month')}-${part('day')}, ${part('weekday')}, ${part('timeZoneName').replace('GMT', 'UTC')}`
}

// Directories whose AGENTS.md (or CLAUDE.md) applies, outermost first:
// from the nearest ancestor with .git down to the cwd; outside Git, the
// cwd alone.
function candidates(cwd: string): string[] {
	let dirs: string[] = []
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
		dirs.unshift(dir)
		if (existsSync(`${dir}/.git`)) return dirs
		if (dirname(dir) === dir) return [resolve(cwd)]
	}
}

// Skills (task 074): names only, so many skills cost few tokens; the
// model reads <dir>/SKILL.md when one fits. One line, a brace group per
// folder: /a/skills/{x,y} /b/skills/z.
// TODO: maybe an option to also list each skill's front matter
// description, so models pick skills better; names suffice for now. Hal's own skills/
// and the user's ~/.agents/skills (or ~/.claude/skills) apply everywhere,
// like SYSTEM.md; a project's .agents/skills (or .claude/skills) only
// where its AGENTS.md would. Only folders holding a
// SKILL.md count; names are sorted so the text stays cache-stable.
function skills(cwd: string): string {
	let subs = ['.agents/skills', '.claude/skills']
	let dirs = [`${paths.repoRoot()}/skills`, ...subs.map((sub) => `${paths.userHome()}/${sub}`)]
	for (let dir of candidates(cwd)) for (let sub of subs) dirs.push(`${dir === '/' ? '' : dir}/${sub}`)
	let groups: string[] = []
	for (let dir of new Set(dirs)) {
		let names: string[] = []
		try {
			names = readdirSync(dir)
				.filter((name) => existsSync(`${dir}/${name}/SKILL.md`))
				.sort()
		} catch {}
		let shown = paths.display(dir)
		if (names.length) groups.push(names.length === 1 ? `${shown}/${names[0]}` : `${shown}/{${names.join(',')}}`)
	}
	return groups.length ? `Skills - read <dir>/SKILL.md when appropriate: ${groups.join(' ')}` : ''
}

// The global ~/.agents/AGENTS.md first, then project files outermost first.
// Each file's imports stay inside its own root.
function agents(cwd: string, sources?: PromptSource[]): string {
	let parts: string[] = []
	let include = (path: string, root: string) => {
		let missing: string[] = [],
			text = promptLang.render(path, {}, sources, missing, undefined, { root })
		if (!missing.length) parts.push(`<file path="${path}">\n${text}\n</file>`)
	}
	let global = `${paths.userHome()}/.agents`
	if (existsSync(`${global}/AGENTS.md`)) include(`${global}/AGENTS.md`, global)
	let dirs = systemPrompt.candidates(cwd),
		root = dirs[0]!
	try {
		root = realpathSync(root)
	} catch {}
	for (let dir of dirs) {
		let path = ['AGENTS.md', 'CLAUDE.md'].map((name) => `${dir === '/' ? '' : dir}/${name}`).find((p) => existsSync(p))
		if (path) include(path, root)
	}
	return parts.join('\n\n')
}

function assemble(input: PromptInput, sources?: PromptSource[], problems?: string[]): string {
	let timezone =
		(input.sessionId ? clients.timezone(input.sessionId) : undefined) ??
		Intl.DateTimeFormat().resolvedOptions().timeZone
	let vars = {
		date: date(input.now, timezone),
		timezone,
		session_id: input.sessionId ?? '',
		session_cwd: paths.display(input.cwd),
		session_model: input.model,
		session_dir: input.sessionId ? paths.display(paths.sessionDir(input.sessionId)) : '',
		session_interactive: String(input.interactive ?? true),
		session_autoclose: String(input.autoclose ?? false),
		hal_src: paths.display(paths.repoRoot()),
		hal_home: paths.display(paths.home()),
		hal_web_url: settings.webUrl(),
		subagent: input.owner ? 'true' : 'false',
		subagent_owner: input.owner ?? '',
		spawn_budget: String(input.slots ?? settings.subagentSlots()),
		fork: input.parent ? 'true' : 'false',
		fork_parent: input.parent ?? '',
		user_notes: input.noUser ? 'false' : 'true',
		other_tools: nativeTool.summary(),
		skills: systemPrompt.skills(input.cwd),
		agents: systemPrompt.agents(input.cwd, sources),
	}
	return systemPrompt.preprocess(systemPrompt.file(), vars, sources, problems, input.rendered)
}

export type PromptInput = {
	cwd: string
	model: string
	now: number
	sessionId?: string
	noUser?: boolean
	interactive?: boolean
	owner?: string
	parent?: string
	slots?: number
	autoclose?: boolean
	rendered?: PromptRender
}
function build(input: PromptInput, problems?: string[]): string {
	return systemPrompt.assemble(input, undefined, problems)
}
function inspect(input: PromptInput): {
	sources: PromptSource[]
	text: string
	problems: string[]
	sections: PromptRender['sections']
	vars: PromptRender['vars']
} {
	let sources: PromptSource[] = [],
		problems: string[] = [],
		rendered: PromptRender = { sections: [] }
	let text = systemPrompt.assemble({ ...input, rendered }, sources, problems)
	let shift = text.indexOf(rendered.text ?? text)
	if (shift >= 0)
		return {
			sources,
			text,
			problems,
			vars: rendered.vars,
			sections: rendered.sections.map((s) =>
				s.body.trim() ? { ...s, start: s.start + shift, end: s.end + shift } : s,
			),
		}
	// A hook changed the text (task vd9). An intact section keeps its text;
	// a changed one runs from its heading to the next later heading or
	// unchanged text between sections. A missing heading withdraws it.
	let full = rendered.text ?? '',
		shown = rendered.sections.filter((s) => s.body.trim()),
		from = 0
	let gaps = shown.map((s, i) => full.slice(s.end, shown[i + 1]?.start ?? full.length).trim())
	let sections = rendered.sections.flatMap((s) => {
		if (!s.body.trim()) return [s]
		let i = shown.indexOf(s),
			head = `# ${s.title}\n`,
			intact = text.indexOf(head + s.body, from)
		let start = intact >= 0 ? intact : text.indexOf(head, from)
		if (start < 0) return []
		let at = start + head.length,
			end =
				intact >= 0
					? at + s.body.length
					: Math.min(
							text.length,
							...[
								...shown.slice(i + 1).map((n) => text.indexOf(`\n# ${n.title}\n`, at)),
								...gaps
									.slice(i)
									.filter(Boolean)
									.map((g) => text.indexOf(g, at)),
							].filter((n) => n >= 0),
						)
		let body = text.slice(at, end).replace(/\s+$/, '')
		from = at + body.length
		return [{ ...s, body, start, end: from }]
	})
	return { sources, text, problems, vars: rendered.vars, sections }
}

export const systemPrompt = {
	file: () => systemFile,
	preprocess: (...args: Parameters<typeof promptLang.render>) => promptLang.render(...args),
	skills,
	agents,
	candidates,
	assemble,
	inspect,
	build,
}
