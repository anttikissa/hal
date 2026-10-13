// Hookable prompt assembly from one input snapshot (tasks ar, q5g, ftg).

import { existsSync, readdirSync, readFileSync, realpathSync } from 'fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import { settings } from '../common/settings.ts'
import { clients } from './clients.ts'
import { nativeTool } from './native-tool.ts'
import { paths } from './paths.ts'
import { promptTemplate, type PromptRender, type PromptSource } from './prompt-template.ts'
export type { PromptSource } from './prompt-template.ts'
const systemFile = resolve(import.meta.dir, '../../SYSTEM.md')

function date(now: number, timeZone: string): string {
	let parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', timeZoneName: 'longOffset' }).formatToParts(now)
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
// apply everywhere, like SYSTEM.md; a project's .agents/skills (or
// .claude/skills) only where its AGENTS.md would. Only folders holding a
// SKILL.md count; names are sorted so the text stays cache-stable.
function skills(cwd: string): string {
	let dirs = [`${paths.repoRoot()}/skills`]
	for (let dir of candidates(cwd)) for (let sub of ['.agents/skills', '.claude/skills']) dirs.push(`${dir === '/' ? '' : dir}/${sub}`)
	let groups: string[] = []
	for (let dir of new Set(dirs)) {
		let names: string[] = []
		try {
			names = readdirSync(dir).filter((name) => existsSync(`${dir}/${name}/SKILL.md`)).sort()
		} catch {}
		if (names.length) groups.push(names.length === 1 ? `${dir}/${names[0]}` : `${dir}/{${names.join(',')}}`)
	}
	return groups.length ? `Skills - read <dir>/SKILL.md when appropriate: ${groups.join(' ')}` : ''
}

function read(path: string): string | undefined {
	try {
		return readFileSync(path, 'utf8')
	} catch {
		return undefined
	}
}

// Claude Code compatible imports (task d2j): a line that is only @path
// becomes that file's text when its real path lies inside the project
// root; anything else stays verbatim, so a repo cannot pull in ~/.ssh.
// The project-boundary test stays (system-prompt.test.ts). The rest was
// tested once, then the tests were deleted. If you change this code,
// first write tests for: a nested in-project import expands; a missing
// file, a cycle's closing line and an inline @ stay verbatim.
function imports(file: string, text: string, root: string, sources?: PromptSource[], chain = [file]): string {
	return text.split('\n').map((line) => {
		let name = /^\s*@(\S+)\s*$/.exec(line)?.[1]
		if (!name) return line
		let target: string
		try {
			target = realpathSync(resolve(dirname(file), name))
		} catch {
			return line
		}
		let rel = relative(root, target)
		if (!rel || rel.split(sep)[0] === '..' || isAbsolute(rel) || chain.includes(target)) return line
		let body = read(target)
		if (body === undefined) return line
		sources?.push({ path: target, bytes: Buffer.byteLength(body) })
		return imports(target, body.trim(), root, sources, [...chain, target])
	}).join('\n')
}

function agents(cwd: string, sources?: PromptSource[]): string {
	let parts: string[] = []
	let skillList = skills(cwd)
	if (skillList) parts.push(skillList)
	let dirs = systemPrompt.candidates(cwd), root = dirs[0]!
	try {
		root = realpathSync(root)
	} catch {}
	for (let dir of dirs) {
		for (let name of ['AGENTS.md', 'CLAUDE.md']) {
			let path = `${dir === '/' ? '' : dir}/${name}`, text = read(path)
			if (text === undefined) continue
			sources?.push({ path, bytes: Buffer.byteLength(text) })
			let real = path
			try {
				real = realpathSync(path)
			} catch {}
			parts.push(`<file path="${path}">\n${imports(real, text.trim(), root, sources)}\n</file>`)
			break
		}
	}
	return parts.join('\n\n')
}

function assemble(input: PromptInput, sources?: PromptSource[], problems?: string[]): string {
	let fromSource = relative(paths.repoRoot(), resolve(input.cwd))
	let timezone = (input.sessionId ? clients.timezone(input.sessionId) : undefined) ?? Intl.DateTimeFormat().resolvedOptions().timeZone
	let vars = {
		date: date(input.now, timezone), timezone,
		session_id: input.sessionId ?? '', session_cwd: paths.display(input.cwd), session_model: input.model,
		session_dir: input.sessionId ? paths.display(paths.sessionDir(input.sessionId)) : '',
		session_interactive: String(input.interactive ?? true), session_autoclose: String(input.autoclose ?? false),
		hal_dir: paths.display(paths.repoRoot()), hal_home: paths.home(), hal_web_url: settings.webUrl(),
		hal_source: fromSource !== '..' && !fromSource.startsWith(`..${sep}`) && !isAbsolute(fromSource) ? 'true' : 'false',
		subagent: input.owner ? 'true' : 'false', subagent_owner: input.owner ?? '',
		subagent_slots: String(input.slots ?? settings.subagentSlots()),
		fork: input.parent ? 'true' : 'false', fork_parent: input.parent ?? '',
		user_notes: input.noUser ? 'false' : 'true', tools_summary: nativeTool.summary(),
		agents: systemPrompt.agents(input.cwd, sources),
	}
	return systemPrompt.preprocess(systemPrompt.file(), vars, sources, problems, input.rendered)
}

export type PromptInput = { cwd: string; model: string; now: number; sessionId?: string; noUser?: boolean; interactive?: boolean; owner?: string; parent?: string; slots?: number; autoclose?: boolean; rendered?: PromptRender }
function build(input: PromptInput, problems?: string[]): string {
	return systemPrompt.assemble(input, undefined, problems)
}
function inspect(input: PromptInput): { sources: PromptSource[]; text: string; problems: string[]; sections: PromptRender['sections'] } {
	let sources: PromptSource[] = [], problems: string[] = [], rendered: PromptRender = { sections: [] }
	let text = systemPrompt.assemble({ ...input, rendered }, sources, problems)
	let shift = text.indexOf(rendered.text ?? text)
	if (shift >= 0) return { sources, text, problems, sections: rendered.sections.map((s) => s.body.trim() ? { ...s, start: s.start + shift, end: s.end + shift } : s) }
	// A hook changed the text (task vd9). An intact section keeps its text;
	// a changed one runs from its heading to the next later heading or
	// unchanged text between sections. A missing heading withdraws it.
	let full = rendered.text ?? '', shown = rendered.sections.filter((s) => s.body.trim()), from = 0
	let gaps = shown.map((s, i) => full.slice(s.end, shown[i + 1]?.start ?? full.length).trim())
	let sections = rendered.sections.flatMap((s) => {
		if (!s.body.trim()) return [s]
		let i = shown.indexOf(s), head = `# ${s.title}\n`, intact = text.indexOf(head + s.body, from)
		let start = intact >= 0 ? intact : text.indexOf(head, from)
		if (start < 0) return []
		let at = start + head.length, end = intact >= 0 ? at + s.body.length : Math.min(text.length, ...[...shown.slice(i + 1).map((n) => text.indexOf(`\n# ${n.title}\n`, at)), ...gaps.slice(i).filter(Boolean).map((g) => text.indexOf(g, at))].filter((n) => n >= 0))
		let body = text.slice(at, end).replace(/\s+$/, '')
		from = at + body.length
		return [{ ...s, body, start, end: from }]
	})
	return { sources, text, problems, sections }
}

export const systemPrompt = {
	file: () => systemFile,
	preprocess: (...args: Parameters<typeof promptTemplate.render>) => promptTemplate.render(...args),
	agents,
	candidates,
	assemble,
	inspect,
	build,
}
